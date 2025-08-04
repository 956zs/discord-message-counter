import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  ChannelType,
  TextChannel,
  EmbedBuilder,
} from "discord.js";
import { pool } from "../../database";

const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));

module.exports = {
  data: new SlashCommandBuilder()
    .setName("sync-messages")
    .setDescription("同步伺服器中的所有歷史訊息 (可從中斷點恢復)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction: ChatInputCommandInteraction) {
    if (!interaction.guild || !interaction.user) {
      return interaction.reply({
        content: "此指令發生了非預期的錯誤。",
        ephemeral: true,
      });
    }

    await interaction.reply({
      content: "✅ 指令已收到！正在檢查同步狀態...",
      ephemeral: true,
    });

    const guild = interaction.guild;
    const user = interaction.user;
    const dbClient = await pool.connect(); // 使用單一 client 來處理事務

    try {
      // 1. 檢查並鎖定同步狀態
      await dbClient.query("BEGIN");
      const statusRes = await dbClient.query(
        "SELECT status FROM sync_status WHERE guild_id = $1 FOR UPDATE",
        [guild.id]
      );

      if (
        statusRes.rows.length > 0 &&
        statusRes.rows[0].status === "in_progress"
      ) {
        await interaction.followUp({
          content: "❌ 上一個同步任務仍在進行中，請等待其完成或失敗。",
          ephemeral: true,
        });
        await dbClient.query("COMMIT"); // 釋放鎖
        return;
      }

      // 將狀態設置為 in_progress，並插入或更新記錄
      await dbClient.query(
        `INSERT INTO sync_status (guild_id, status, last_updated) VALUES ($1, 'in_progress', NOW())
         ON CONFLICT (guild_id) DO UPDATE SET status = 'in_progress', last_updated = NOW()`,
        [guild.id]
      );
      await dbClient.query("COMMIT");

      // 2. 獲取上次同步進度
      const lastSyncRes = await dbClient.query(
        "SELECT last_synced_channel_id FROM sync_status WHERE guild_id = $1",
        [guild.id]
      );
      const lastSyncedChannelId = lastSyncRes.rows[0]?.last_synced_channel_id;

      // 準備進度報告
      const progressEmbed = new EmbedBuilder()
        .setTitle(`🔄 訊息同步中 - ${guild.name}`)
        .setColor("Blue");
      const progressMessage = await user.send({ embeds: [progressEmbed] });

      // 3. 獲取並過濾頻道列表
      const allChannels = Array.from(
        guild.channels.cache
          .filter(
            (ch): ch is TextChannel =>
              ch.type === ChannelType.GuildText && ch.viewable
          )
          .values()
      );

      let channelsToSync = allChannels;
      let startIndex = 0;

      if (lastSyncedChannelId) {
        const lastSyncIndex = allChannels.findIndex(
          (ch) => ch.id === lastSyncedChannelId
        );
        if (lastSyncIndex > -1) {
          startIndex = lastSyncIndex + 1;
          channelsToSync = allChannels.slice(startIndex);
          await user.send({
            content: `ℹ️ 偵測到上次同步中斷，將從頻道 **#${
              allChannels[startIndex]?.name || "未知"
            }** 繼續。`,
          });
        }
      }

      if (channelsToSync.length === 0 && lastSyncedChannelId) {
        await user.send({ content: "✅ 所有頻道均已同步完成，無需操作。" });
        await dbClient.query(
          "UPDATE sync_status SET status = 'completed' WHERE guild_id = $1",
          [guild.id]
        );
        return;
      }

      // 4. 主同步迴圈
      for (let i = 0; i < channelsToSync.length; i++) {
        const channel = channelsToSync[i];
        const overallProgress = Math.round(
          ((startIndex + i + 1) / allChannels.length) * 100
        );

        // 更新進度 Embed
        progressEmbed.setDescription(
          `**進度: ${overallProgress}%**\n正在掃描頻道: #${channel.name} (${
            startIndex + i + 1
          }/${allChannels.length})`
        );
        await progressMessage.edit({ embeds: [progressEmbed] });

        // 在同步前，清空該頻道的舊紀錄 (冪等性保證)
        await dbClient.query(
          "DELETE FROM message_counts WHERE guild_id = $1 AND channel_id = $2",
          [guild.id, channel.id]
        );

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
              // ★ INSERT 語法更新
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

        // 頻道成功完成後，立即更新狀態
        await dbClient.query(
          "UPDATE sync_status SET last_synced_channel_id = $1, last_updated = NOW() WHERE guild_id = $2",
          [channel.id, guild.id]
        );
      }

      // 5. 任務全部完成
      await dbClient.query(
        "UPDATE sync_status SET status = 'completed', last_updated = NOW() WHERE guild_id = $1",
        [guild.id]
      );
      progressEmbed
        .setTitle(`✅ 訊息同步完成 - ${guild.name}`)
        .setDescription("所有頻道皆已成功同步！")
        .setColor("Green");
      await progressMessage.edit({ embeds: [progressEmbed] });
    } catch (error) {
      console.error("執行 sync-messages 時發生錯誤:", error);
      // 任務失敗，更新狀態
      await dbClient.query(
        "UPDATE sync_status SET status = 'failed', last_updated = NOW() WHERE guild_id = $1",
        [guild.id]
      );
      await user.send({
        content:
          "❌ 在同步過程中發生了嚴重錯誤，任務已中斷。請檢查主控台的詳細紀錄。下次執行時將會自動從中斷點恢復。",
      });
    } finally {
      dbClient.release(); // 釋放資料庫連線
    }
  },
};
