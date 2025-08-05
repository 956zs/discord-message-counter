import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  ChannelType,
  TextChannel,
  EmbedBuilder,
  Message,
  VoiceChannel,
  ThreadChannel,
  MessageFlags,
} from "discord.js";
import { Worker } from "worker_threads";
import * as path from "path";
import * as os from "os";
import { pool } from "../../database";
import { redis } from "../../database/redis";
import { flushDirtyCountsToDB } from "../../database/write-behind";
import { MessageCount } from "../../database";

const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));

module.exports = {
  data: new SlashCommandBuilder()
    .setName("sync-full")
    .setDescription("【高耗時】刪除並重新同步伺服器所有歷史訊息")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction: ChatInputCommandInteraction) {
    if (!interaction.guild || !interaction.user || !interaction.channel) {
      return interaction.reply({
        content: "此指令發生了非預期的錯誤。",
        flags: MessageFlags.Ephemeral,
      });
    }

    // Confirmation step
    await interaction.reply({
      content:
        "⚠️ **極度危險操作！**\n這將會刪除本伺服器所有訊息計數，並從頭開始同步，可能需要數小時。\n**你確定要繼續嗎？** (請在 15 秒內於此頻道回覆 `confirm` )",
      flags: MessageFlags.Ephemeral,
    });

    const filter = (m: Message) =>
      interaction.user.id === m.author.id &&
      m.content.toLowerCase() === "confirm";
    try {
      if (
        interaction.channel?.isTextBased() &&
        !interaction.channel.isDMBased()
      ) {
        const collected = await interaction.channel.awaitMessages({
          filter,
          max: 1,
          time: 15_000,
          errors: ["time"],
        });
        if (collected)
          await interaction.followUp({
            content:
              "✅ 確認收到，完全同步任務即將開始... 請留意私訊獲取進度。",
            flags: MessageFlags.Ephemeral,
          });
      } else {
        return interaction.followUp({
          content: "❌ 此指令無法在此頻道中使用。",
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch {
      return interaction.followUp({
        content: "❌ 操作已取消。",
        flags: MessageFlags.Ephemeral,
      });
    }

    const guild = interaction.guild;
    const user = interaction.user;

    // ★★★ 在開始同步前，強制將所有待寫入的 Redis 數據刷入資料庫 ★★★
    console.log("[Sync-Full] 正在強制執行一次性的批次寫入以同步最新數據...");
    await flushDirtyCountsToDB();
    console.log("[Sync-Full] 批次寫入完成，即將開始完全同步。");

    const dbClient = await pool.connect();
    const lockKey = `sync-lock:${interaction.guildId}`;
    const lockTimeout = 3600;

    const acquiredLock = await redis.set(
      lockKey,
      interaction.user.id,
      "EX",
      lockTimeout,
      "NX"
    );

    if (!acquiredLock) {
      const holderId = await redis.get(lockKey);
      return interaction.followUp({
        content: `❌ 目前已有一個同步任務正在由 <@${holderId}> 執行中，請稍後再試。`,
        flags: MessageFlags.Ephemeral,
      });
    }

    const startTime = Date.now(); // ★ Record start time

    try {
      await dbClient.query(
        `INSERT INTO sync_status (guild_id, full_sync_status, last_full_sync_updated) VALUES ($1, 'in_progress', NOW())
             ON CONFLICT (guild_id) DO UPDATE SET full_sync_status = 'in_progress', last_full_sync_updated = NOW()`,
        [guild.id]
      );

      const progressEmbed = new EmbedBuilder()
        .setTitle("🚀 完全同步任務已啟動")
        .setColor("Blue")
        .setFooter({ text: `由 ${interaction.user.tag} 啟動` });

      const progressMessage = await user.send({ embeds: [progressEmbed] });

      await dbClient.query("DELETE FROM message_counts WHERE guild_id = $1", [
        guild.id,
      ]);

      // --- Comprehensive Channel Fetching ---
      type TextBasedChannel = TextChannel | VoiceChannel;
      type MessageableChannel = TextBasedChannel | ThreadChannel;

      progressEmbed.setDescription("正在獲取所有可讀取頻道列表...");
      await progressMessage.edit({ embeds: [progressEmbed] });

      // 1. Get base text channels
      const baseChannels: TextBasedChannel[] = guild.channels.cache
        .filter(
          (ch): ch is TextBasedChannel =>
            (ch.type === ChannelType.GuildText ||
              ch.type === ChannelType.GuildAnnouncement ||
              ch.type === ChannelType.GuildVoice) &&
            ch.viewable &&
            ch.permissionsFor(guild.members.me!)?.has("ReadMessageHistory")
        )
        .map((c: TextBasedChannel) => c);

      // 2. Fetch all threads in the guild
      const allThreads = guild.channels.cache
        .filter(
          (ch) =>
            ch.isThread() &&
            ch.viewable &&
            ch.permissionsFor(guild.members.me!)?.has("ReadMessageHistory")
        )
        .map((t) => t as ThreadChannel);

      // 3. Merge and deduplicate
      const allMessageableChannels: MessageableChannel[] = [
        ...baseChannels,
        ...allThreads,
      ];
      const uniqueChannels = new Map<string, MessageableChannel>();
      allMessageableChannels.forEach((ch: MessageableChannel) =>
        uniqueChannels.set(ch.id, ch)
      );
      const finalChannelList = Array.from(uniqueChannels.values());

      const totalChannels = finalChannelList.length;
      console.log(
        `[Sync-Full] 找到 ${totalChannels} 個獨特的可訊息頻道進行同步。`
      );

      const numWorkers = Math.min(os.cpus().length, totalChannels);
      const channelsPerWorker = Math.ceil(totalChannels / numWorkers);
      const channelChunks: MessageableChannel[][] = [];

      for (let i = 0; i < totalChannels; i += channelsPerWorker) {
        channelChunks.push(finalChannelList.slice(i, i + channelsPerWorker));
      }

      console.log(
        `[Sync-Full] Spawning ${numWorkers} workers to process ${totalChannels} channels.`
      );

      let totalMessagesProcessed = 0;
      let channelsCompleted = 0;

      const workerPromises = channelChunks.map((chunk, index) => {
        return new Promise<MessageCount[]>((resolve, reject) => {
          const worker = new Worker(
            path.resolve(__dirname, "../../workers/sync-worker.js"),
            {
              workerData: {
                channelIds: chunk.map((ch) => ch.id),
                token: interaction.client.token,
                guildId: guild.id,
              },
            }
          );

          worker.on(
            "message",
            (result: {
              counts?: MessageCount[];
              error?: string;
              type?: string;
              progress?: any;
            }) => {
              if (result.type === "progress") {
                // Handle progress updates if implemented in worker
              } else if (result.error) {
                console.error(`[Worker ${index}] Error:`, result.error);
                // Depending on desired behavior, you might reject or resolve with empty
              } else if (result.counts) {
                channelsCompleted += chunk.length;
                const progress = Math.round(
                  (channelsCompleted / totalChannels) * 100
                );
                const progressBar =
                  "█".repeat(Math.round(progress / 5)) +
                  "░".repeat(20 - Math.round(progress / 5));
                const elapsedTime = (Date.now() - startTime) / 1000;

                progressEmbed
                  .setTitle(`🔄 同步進行中... (${progress}%)`)
                  .setDescription(
                    `**進度**: ${progressBar}\n` +
                      `**頻道**: ${channelsCompleted} / ${totalChannels} 個已完成\n` +
                      `**耗時**: ${Math.floor(elapsedTime / 60)}分 ${Math.round(
                        elapsedTime % 60
                      )}秒`
                  );
                progressMessage
                  .edit({ embeds: [progressEmbed] })
                  .catch(console.error);

                resolve(result.counts);
              }
            }
          );

          worker.on("error", reject);
          worker.on("exit", (code) => {
            if (code !== 0) {
              reject(
                new Error(`Worker ${index} stopped with exit code ${code}`)
              );
            }
          });
        });
      });

      const allCounts = (await Promise.all(workerPromises)).flat();

      console.log(
        `[Sync-Full] All workers finished. Aggregated ${allCounts.length} total records.`
      );

      if (allCounts.length > 0) {
        console.log("[Sync-Full] Writing aggregated data to PostgreSQL...");
        const BATCH_SIZE = 1000; // Insert 1000 records at a time
        await dbClient.query("BEGIN");
        for (let i = 0; i < allCounts.length; i += BATCH_SIZE) {
          const batch = allCounts.slice(i, i + BATCH_SIZE);
          const values = batch
            .map(
              (c) =>
                `(${c.user_id}, ${c.guild_id}, ${c.channel_id}, '${c.message_date}', ${c.count})`
            )
            .join(",");

          const query = `
                INSERT INTO message_counts (user_id, guild_id, channel_id, message_date, count)
                VALUES ${values}
                ON CONFLICT (user_id, guild_id, channel_id, message_date)
                DO UPDATE SET count = message_counts.count + excluded.count;
            `;
          await dbClient.query(query);
        }
        await dbClient.query("COMMIT");
        console.log("[Sync-Full] Database write complete.");
      }

      const endTime = Date.now();
      const totalTime = (endTime - startTime) / 1000;

      // ★★★ 任務完成後的關鍵步驟 ★★★

      // 1. 清除舊的 Redis 排行榜
      const leaderboardKey = `leaderboard:${guild.id}`;
      await redis.del(leaderboardKey);

      // 2. 從 PostgreSQL 中查詢出最終的、完整的排行榜數據
      console.log(`[Sync] 正在從 PostgreSQL 讀取最終排名以重建 Redis 快取...`);
      const finalCountsQuery = `
          SELECT user_id, SUM(count) as total_count
          FROM message_counts
          WHERE guild_id = $1
          GROUP BY user_id;
      `;
      const { rows } = await pool.query(finalCountsQuery, [guild.id]);

      // 3. 使用 ZADD 批量寫入 Redis Sorted Set
      if (rows.length > 0) {
        // Redis 的 ZADD 命令可以一次接收多個 [score, member] 對
        const redisArgs = rows.flatMap((row) => [
          parseInt(row.total_count, 10),
          row.user_id,
        ]);
        await redis.zadd(leaderboardKey, ...(redisArgs as (string | number)[]));
        console.log(
          `[Sync] 成功將 ${rows.length} 條用戶排名數據重建到 Redis。`
        );
      }

      progressEmbed
        .setTitle("✅ 完全同步成功！")
        .setColor("Green")
        .setDescription(
          `所有 ${totalChannels} 個頻道均已同步完成。\n` +
            `**總耗時**: **${Math.floor(totalTime / 60)}分 ${Math.round(
              totalTime % 60
            )}秒**`
        );
      await progressMessage.edit({ embeds: [progressEmbed] });

      await dbClient.query(
        "UPDATE sync_status SET full_sync_status = 'completed', last_full_sync_updated = NOW() WHERE guild_id = $1",
        [guild.id]
      );
    } catch (error) {
      console.error("執行 sync-full 時發生錯誤:", error);
      await dbClient.query(
        "UPDATE sync_status SET full_sync_status = 'failed', last_full_sync_updated = NOW() WHERE guild_id = $1",
        [guild.id]
      );
      await user.send({ content: "❌ 完全同步任務失敗，請檢查後台日誌。" });
    } finally {
      dbClient.release();
      await redis.del(lockKey);
    }
  },
};
