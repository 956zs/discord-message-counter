import { Events, Message } from "discord.js";
import { pool } from "../database";
import { redis } from "../database/redis";

module.exports = {
  name: Events.MessageCreate,
  async execute(message: Message) {
    if (message.author.bot || !message.guild) return;

    const { author, guild } = message;

    try {
      // 1. 更新 PostgreSQL (權威數據源)
      // 我們可以簡化，不再需要事務，因為 Redis 的更新失敗是可接受的
      const query = `
        INSERT INTO message_counts (user_id, guild_id, channel_id, count)
        VALUES ($1, $2, $3, 1)
        ON CONFLICT (user_id, guild_id, channel_id)
        DO UPDATE SET count = message_counts.count + 1;
      `;
      await pool.query(query, [author.id, guild.id, message.channel.id]);

      // 2. ★ 更新 Redis 排行榜 Sorted Set
      // ZINCRBY: 將指定成員的分數加 1
      // 這個操作極快，對效能影響微乎其微
      const leaderboardKey = `leaderboard:${guild.id}`;
      await redis.zincrby(leaderboardKey, 1, author.id);

      // 3. ★ (可選但推薦) 讓排行榜快取失效
      // 為了保證數據即時性，當有人發言時，我們可以刪除所有頁面的快取
      // 這樣下次有人請求時，就會重新生成包含最新數據的排行榜
      const keys = await redis.keys(`leaderboard:page:${guild.id}:*`);
      if (keys.length > 0) {
        await redis.del(keys);
      }
    } catch (error) {
      console.error("在 messageCreate 事件中發生錯誤:", error);
    }
  },
};
