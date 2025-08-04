import { Events, Message } from "discord.js";
import { pool } from "../database";

module.exports = {
  name: Events.MessageCreate,
  async execute(message: Message) {
    // 忽略來自機器人本身的訊息，並確保訊息來自於一個伺服器
    if (message.author.bot || !message.guild) return;

    try {
      // 使用高效的 UPSERT (UPDATE + INSERT) 語法
      // 如果使用者在該伺服器的紀錄已存在，則將 count + 1
      // 如果不存在，則新增一筆紀錄，count 設為 1
      const query = `
          INSERT INTO message_counts (user_id, guild_id, channel_id, count)
          VALUES ($1, $2, $3, 1)
          ON CONFLICT (user_id, guild_id, channel_id)
          DO UPDATE SET count = message_counts.count + 1;
      `;

      // 執行查詢
      await pool.query(query, [
        message.author.id,
        message.guild.id,
        message.channel.id,
      ]);
    } catch (error) {
      console.error("在 messageCreate 事件中更新資料庫時發生錯誤:", error);
    }
  },
};
