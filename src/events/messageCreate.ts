import { Events, Message } from "discord.js";
import { redis } from "../database/redis";

const DIRTY_COUNTS_PREFIX = "dirty_counts:";

module.exports = {
  name: Events.MessageCreate,
  async execute(message: Message) {
    if (message.author.bot || !message.guild) return;

    const { author, guild, channel } = message;

    try {
      // --- Write-Behind Caching with New Schema ---
      // 1. 建立一個複合鍵，包含 user, channel, 和 date
      const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      const compositeKey = `${author.id}:${channel.id}:${today}`;

      // 2. 將增量寫入 "dirty" hash
      // 我們仍然使用 guild.id 作為 hash 的主鍵，但欄位現在是複合鍵
      const dirtyKey = `${DIRTY_COUNTS_PREFIX}${guild.id}`;
      await redis.hincrby(dirtyKey, compositeKey, 1);

      // 2. ★ 即時更新 Redis 排行榜 Sorted Set (用於即時檢視)
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
