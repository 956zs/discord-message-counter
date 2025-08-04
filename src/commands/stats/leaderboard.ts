import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from "discord.js";
import { pool } from "../../database";

module.exports = {
  data: new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("顯示伺服器訊息排行榜"),

  async execute(interaction: ChatInputCommandInteraction) {
    // 確保指令在伺服器中使用
    if (!interaction.guild) {
      await interaction.reply({
        content: "此指令只能在伺服器中使用。",
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply(); // 延遲回覆，因為查詢資料庫可能需要一些時間

    try {
      const guildId = interaction.guild.id;

      // 從資料庫查詢該伺服器的前 10 名使用者
      const query = `
          SELECT user_id, SUM(count) AS total_count
          FROM message_counts
          WHERE guild_id = $1
          GROUP BY user_id
          ORDER BY total_count DESC
          LIMIT 10;
      `;
      const { rows } = await pool.query(query, [guildId]);

      if (rows.length === 0) {
        await interaction.editReply("目前沒有任何訊息紀錄可顯示排行榜。");
        return;
      }

      // 建立一個美觀的嵌入式訊息 (Embed)
      const leaderboardEmbed = new EmbedBuilder()
        .setColor(0x0099ff)
        .setTitle(`**${interaction.guild.name}** 的訊息排行榜`)
        .setTimestamp();

      // 非同步地獲取使用者名稱並建立描述
      const description = await Promise.all(
        rows.map(async (row, index) => {
          try {
            const user = await interaction.client.users.fetch(row.user_id);
            return `${index + 1}. ${user.tag} - **${row.total_count}** 則訊息`;
          } catch {
            return `${index + 1}. *未知使用者* - **${row.total_count}** 則訊息`;
          }
        })
      );

      leaderboardEmbed.setDescription(description.join("\n"));

      await interaction.editReply({ embeds: [leaderboardEmbed] });
    } catch (error) {
      console.error("執行 leaderboard 指令時發生錯誤:", error);
      await interaction.editReply("查詢排行榜時發生錯誤，請稍後再試。");
    }
  },
};
