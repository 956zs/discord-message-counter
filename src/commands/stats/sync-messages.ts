import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  ChannelType,
  TextChannel,
} from "discord.js";
import { pool } from "../../database";

module.exports = {
  data: new SlashCommandBuilder()
    .setName("sync-messages")
    .setDescription("同步伺服器中的所有歷史訊息 (僅限管理員)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator), // 僅限管理員使用

  async execute(interaction: ChatInputCommandInteraction) {
    if (!interaction.guild) {
      await interaction.reply({
        content: "此指令只能在伺服器中使用。",
        ephemeral: true,
      });
      return;
    }

    await interaction.reply({
      content:
        "✅ **開始同步歷史訊息...** 這可能需要很長的時間，請耐心等候。\n我將在每個頻道完成後通知你。",
      ephemeral: true,
    });

    const guild = interaction.guild;
    let totalSynced = 0;

    try {
      // 取得伺服器中所有可見的文字頻道
      const channels = guild.channels.cache.filter(
        (channel): channel is TextChannel =>
          channel.type === ChannelType.GuildText && channel.viewable
      );

      for (const channel of channels.values()) {
        let channelSynced = 0;
        let lastId: string | undefined;

        await interaction.followUp({
          content: `正在掃描頻道: #${channel.name}...`,
          ephemeral: true,
        });

        while (true) {
          const messages = await channel.messages.fetch({
            limit: 100,
            before: lastId,
          });
          if (messages.size === 0) break;

          const counts: { [userId: string]: number } = {};

          for (const message of messages.values()) {
            if (message.author.bot) continue;
            counts[message.author.id] = (counts[message.author.id] || 0) + 1;
          }

          // 批次更新資料庫
          if (Object.keys(counts).length > 0) {
            const client = await pool.connect();
            try {
              await client.query("BEGIN");
              for (const userId in counts) {
                const query = `
                                    INSERT INTO message_counts (user_id, guild_id, count)
                                    VALUES ($1, $2, $3)
                                    ON CONFLICT (user_id, guild_id)
                                    DO UPDATE SET count = message_counts.count + $3;
                                `;
                await client.query(query, [userId, guild.id, counts[userId]]);
              }
              await client.query("COMMIT");
            } catch (e) {
              await client.query("ROLLBACK");
              throw e;
            } finally {
              client.release();
            }
          }

          channelSynced += Object.values(counts).reduce((a, b) => a + b, 0);
          lastId = messages.lastKey();
        }

        totalSynced += channelSynced;
        await interaction.followUp({
          content: `✅ 頻道 #${channel.name} 同步完成，共處理 ${channelSynced} 則訊息。`,
          ephemeral: true,
        });
      }

      await interaction.followUp({
        content: `🎉 **所有頻道同步完成！** 總共處理了 ${totalSynced} 則訊息。`,
        ephemeral: true,
      });
    } catch (error) {
      console.error("執行 sync-messages 指令時發生錯誤:", error);
      await interaction.followUp({
        content: "同步過程中發生嚴重錯誤，請檢查主控台紀錄。",
        ephemeral: true,
      });
    }
  },
};
