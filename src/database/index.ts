import { Pool } from "pg";
import "dotenv/config";

// 建立一個新的連線池實例
// Pool 會自動管理客戶端連線的開啟與關閉
export const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 5432,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
});

// 可選：新增一個事件監聽器來處理連線錯誤
pool.on("error", (err, client) => {
  console.error("資料庫連線池發生未預期的錯誤", err);
  process.exit(-1);
});
