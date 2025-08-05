import { redis } from "./redis";
import { pool } from "./index";

const DIRTY_COUNTS_PREFIX = "dirty_counts:";

/**
 * Represents the parsed data from a composite key in Redis.
 */
interface ParsedDirtyData {
  userId: string;
  channelId: string;
  messageDate: string;
  count: number;
}

/**
 * 將 Redis 中暫存的 "dirty" 計數批量寫入 PostgreSQL。
 * 這個函數會被一個定時器週期性地調用。
 */
export async function flushDirtyCountsToDB() {
  try {
    const dirtyKeys = await redis.keys(`${DIRTY_COUNTS_PREFIX}*`);

    if (dirtyKeys.length === 0) {
      return;
    }

    console.log(
      `[Write-Behind] 檢測到 ${dirtyKeys.length} 個伺服器有待寫入的更新。`
    );

    for (const key of dirtyKeys) {
      const guildId = key.replace(DIRTY_COUNTS_PREFIX, "");

      // 原子性地取出所有待更新的計數並清空 hash
      const pipelineResult = await redis
        .pipeline()
        .hgetall(key)
        .del(key)
        .exec();

      if (!pipelineResult) {
        console.error(`[Write-Behind] Pipeline for key ${key} failed.`);
        continue;
      }

      const [hgetallError, hgetallResult] = pipelineResult[0];
      const [delError, _] = pipelineResult[1];

      if (hgetallError || delError) {
        console.error(
          `[Write-Behind] Error in pipeline for key ${key}:`,
          hgetallError || delError
        );
        continue;
      }

      const compositeCounts = hgetallResult as {
        [compositeKey: string]: string;
      };

      if (!compositeCounts || Object.keys(compositeCounts).length === 0) {
        continue;
      }

      // 解析複合鍵並準備數據
      const dataToInsert: ParsedDirtyData[] = Object.entries(
        compositeCounts
      ).map(([compositeKey, countStr]) => {
        const [userId, channelId, messageDate] = compositeKey.split(":");
        return {
          userId,
          channelId,
          messageDate,
          count: parseInt(countStr, 10),
        };
      });

      if (dataToInsert.length === 0) {
        continue;
      }

      console.log(
        `[Write-Behind] 正在處理伺服器 ${guildId}，共 ${dataToInsert.length} 條更新記錄。`
      );

      // 準備並執行批次更新
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        const query = `
          INSERT INTO message_counts (user_id, guild_id, channel_id, message_date, count)
          SELECT
            t.user_id,
            $1 AS guild_id,
            t.channel_id,
            t.message_date::date,
            t.count
          FROM UNNEST(
            $2::varchar[],
            $3::varchar[],
            $4::varchar[],
            $5::integer[]
          ) AS t(user_id, channel_id, message_date, count)
          ON CONFLICT (user_id, guild_id, channel_id, message_date)
          DO UPDATE SET count = message_counts.count + EXCLUDED.count;
        `;

        const userIds = dataToInsert.map((d) => d.userId);
        const channelIds = dataToInsert.map((d) => d.channelId);
        const messageDates = dataToInsert.map((d) => d.messageDate);
        const counts = dataToInsert.map((d) => d.count);

        await client.query(query, [
          guildId,
          userIds,
          channelIds,
          messageDates,
          counts,
        ]);

        await client.query("COMMIT");
        console.log(
          `[Write-Behind] 成功將伺服器 ${guildId} 的更新寫入資料庫。`
        );
      } catch (e) {
        await client.query("ROLLBACK");
        console.error(
          `[Write-Behind] 寫入伺服器 ${guildId} 時發生錯誤，正在回滾...`,
          e
        );
        // 在生產環境中，這裡需要一個更健壯的重試或死信隊列機制
      } finally {
        client.release();
      }
    }
  } catch (error) {
    console.error("[Write-Behind] 執行批次寫入時發生嚴重錯誤:", error);
  }
}
