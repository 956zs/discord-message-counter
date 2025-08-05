// src/database/redis.ts
import Redis, { RedisOptions } from "ioredis";
import "dotenv/config";

const redisOptions: RedisOptions = {
  host: process.env.REDIS_HOST || "localhost",
  port: Number(process.env.REDIS_PORT) || 6379,
  db: Number(process.env.REDIS_DB) || 2,
};

if (process.env.REDIS_PASSWORD) {
  redisOptions.password = process.env.REDIS_PASSWORD;
}

export const redis = new Redis(redisOptions);

redis.on("connect", () => {
  console.log("✅ Connected to Redis!");
});

redis.on("error", (err) => {
  console.error("❌ Redis connection error:", err);
});
