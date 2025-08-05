import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  ChannelType,
  TextChannel,
  EmbedBuilder,
  Message,
} from "discord.js";
import { pool } from "../../database";
import { redis } from "../../database/redis";

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
        ephemeral: true,
      });
    }

    // Confirmation step
    await interaction.reply({
      content:
        "⚠️ **極度危險操作！**\n這將會刪除本伺服器所有訊息計數，並從頭開始同步，可能需要數小時。\n**你確定要繼續嗎？** (請在 15 秒內於此頻道回覆 `confirm` )",
      ephemeral: true,
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
            ephemeral: true,
          });
      } else {
        return interaction.followUp({
          content: "❌ 此指令無法在此頻道中使用。",
          ephemeral: true,
        });
      }
    } catch {
      return interaction.followUp({
        content: "❌ 操作已取消。",
        ephemeral: true,
      });
    }

    const guild = interaction.guild;
    const user = interaction.user;
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
        ephemeral: true,
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

      const channels = Array.from(
        guild.channels.cache
          .filter(
            (ch): ch is TextChannel =>
              ch.type === ChannelType.GuildText && ch.viewable
          )
          .values()
      );
      const totalChannels = channels.length;

      for (let i = 0; i < totalChannels; i++) {
        const channel = channels[i];
        const elapsedTime = (Date.now() - startTime) / 1000;
        const estimatedTime =
          (elapsedTime / (i + 1)) * (totalChannels - (i + 1));

        const progress = Math.round(((i + 1) / totalChannels) * 100);
        const progressBar =
          "█".repeat(Math.round(progress / 5)) +
          "░".repeat(20 - Math.round(progress / 5));

        progressEmbed
          .setTitle(`🔄 同步進行中... (${progress}%)`)
          .setDescription(
            `**進度**: ${progressBar}\n` +
              `**頻道**: #${channel.name} (${i + 1} / ${totalChannels})\n` +
              `**耗時**: ${Math.floor(elapsedTime / 60)}分 ${Math.round(
                elapsedTime % 60
              )}秒\n` +
              `**預計剩餘**: ${Math.floor(estimatedTime / 60)}分 ${Math.round(
                estimatedTime % 60
              )}秒`
          );

        if (i % 5 === 0 || i === totalChannels - 1) {
          await progressMessage.edit({ embeds: [progressEmbed] });
        }

        let lastId: string | undefined;
        while (true) {
          const messages = await channel.messages.fetch({
            limit: 100,
            before: lastId,
          });
          if (messages.size === 0) break;

          const counts: { [userId: string]: number } = {};
          for (const msg of messages.values()) {
            if (msg.author.bot) continue;
            counts[msg.author.id] = (counts[msg.author.id] || 0) + 1;
          }

          if (Object.keys(counts).length > 0) {
            await dbClient.query("BEGIN");
            for (const userId in counts) {
              const query = `
                            INSERT INTO message_counts (user_id, guild_id, channel_id, count) VALUES ($1, $2, $3, $4)
                            ON CONFLICT (user_id, guild_id, channel_id) DO UPDATE SET count = message_counts.count + $4;
                        `;
              await dbClient.query(query, [
                userId,
                guild.id,
                channel.id,
                counts[userId],
              ]);
            }
            await dbClient.query("COMMIT");
          }
          lastId = messages.lastKey();
          await delay(1000);
        }
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
        const redisArgs = rows.flatMap((row) => [row.total_count, row.user_id]);
        await redis.zadd(leaderboardKey, ...redisArgs);
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
