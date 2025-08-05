// 載入環境變數
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { Client, Collection, GatewayIntentBits } from "discord.js";
import { flushDirtyCountsToDB } from "./database/write-behind";

// 為了讓 client 物件可以被附加 commands 屬性，我們需要擴充 Client 類別
// 這是一種常見的 TypeScript 實踐
declare module "discord.js" {
  export interface Client {
    commands: Collection<string, any>;
  }
}

// 建立 Discord Client 實例
// 我們需要指定必要的 Intents (意圖)
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // 必須啟用此 Intent 才能讀取訊息內容
  ],
});

// --- 指令處理 ---
client.commands = new Collection();
const commandsPath = path.join(__dirname, "commands");

// 遞迴讀取指令資料夾
const commandFolders = fs.readdirSync(commandsPath);

for (const folder of commandFolders) {
  const folderPath = path.join(commandsPath, folder);
  const commandFiles = fs
    .readdirSync(folderPath)
    .filter((file) => file.endsWith(".ts") || file.endsWith(".js"));

  for (const file of commandFiles) {
    const filePath = path.join(folderPath, file);
    const command = require(filePath);
    // 將指令設定到 Collection 中，以指令名稱為鍵
    if ("data" in command && "execute" in command) {
      client.commands.set(command.data.name, command);
    } else {
      console.log(
        `[警告] 位於 ${filePath} 的指令缺少必要的 "data" 或 "execute" 屬性。`
      );
    }
  }
}

// --- 事件處理 ---
const eventsPath = path.join(__dirname, "events");
const eventFiles = fs
  .readdirSync(eventsPath)
  .filter((file) => file.endsWith(".ts") || file.endsWith(".js"));

for (const file of eventFiles) {
  const filePath = path.join(eventsPath, file);
  const event = require(filePath);
  if (event.once) {
    // 如果 once 屬性為 true，使用 client.once
    client.once(event.name, (...args) => event.execute(...args));
  } else {
    // 否則使用 client.on
    client.on(event.name, (...args) => event.execute(...args));
  }
}

// 使用 .env 檔案中的 token 登入 Discord
const token = process.env.DISCORD_TOKEN;
if (!token) {
  throw new Error("DISCORD_TOKEN 未在 .env 檔案中設定！");
}
client.login(token).then(() => {
  // 設定每 30 秒執行一次批次寫入資料庫的任務
  const WRITE_BEHIND_INTERVAL = 30 * 1000; // 30 秒
  setInterval(() => {
    flushDirtyCountsToDB();
  }, WRITE_BEHIND_INTERVAL);
  console.log(
    `[Write-Behind] 已啟動定時寫入任務，每 ${
      WRITE_BEHIND_INTERVAL / 1000
    } 秒執行一次。`
  );
});
