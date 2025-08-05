import { Events, Client } from "discord.js";
import { pool } from "../database";
import { redis } from "../database/redis";

interface MessageCountRow {
  user_id: string;
  total_count: number;
}

module.exports = {
  name: Events.ClientReady,
  once: true, // 這個事件只會觸發一次
  async execute(client: Client) {
    if (client.user) {
      console.log(`準備完成！已登入為 ${client.user.tag}`);
    } else {
      console.log(`準備完成！但無法取得使用者資訊。`);
      return;
    }

    console.log("正在預熱 Redis 快取...");

    try {
      const guilds = await client.guilds.fetch();
      for (const oauth2guild of guilds.values()) {
        const guild = await oauth2guild.fetch();
        const guildId = guild.id;
        console.log(`正在處理伺服器: ${guild.name} (${guildId})`);

        const leaderboardKey = `leaderboard:${guildId}`;

        // 1. 從 PostgreSQL 獲取權威數據
        const { rows } = await pool.query(
          `SELECT user_id, SUM(count)::BIGINT as total_count FROM message_counts WHERE guild_id = $1 GROUP BY user_id`,
          [guildId]
        );

        // 2. 清除舊的 Redis 快取，確保從乾淨的狀態開始
        await redis.del(leaderboardKey);
        // 為了確保資料一致性，同時刪除所有分頁快取
        const pageCacheKeys = await redis.keys(`leaderboard:page:${guildId}:*`);
        if (pageCacheKeys.length > 0) {
          await redis.del(pageCacheKeys);
        }

        if (rows.length > 0) {
          // 3. 使用 ZADD 一次性將所有成員的分數寫入 Redis Sorted Set
          // redisArgs 的格式為 [score1, member1, score2, member2, ...]
          const redisArgs = rows.flatMap((row: MessageCountRow) => [
            row.total_count,
            row.user_id,
          ]);
          await redis.zadd(
            leaderboardKey,
            ...(redisArgs as (string | number)[])
          );
          console.log(
            ` -> 成功為 ${guild.name} 快取了 ${rows.length} 位成員的資料。`
          );
        } else {
          console.log(
            ` -> 伺服器 ${guild.name} 在資料庫中沒有訊息紀錄，無需快取。`
          );
        }
      }
      console.log("Redis 快取預熱完成！");
    } catch (error) {
      console.error("預熱 Redis 快取時發生錯誤:", error);
    }
  },
};
