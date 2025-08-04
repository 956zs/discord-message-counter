import "dotenv/config";
import { REST } from "@discordjs/rest";
import { Routes } from "discord.js";
import fs from "node:fs";
import path from "node:path";

const commands = [];
// 從 commands 資料夾讀取所有指令檔案
const commandsPath = path.join(__dirname, "commands");
const commandFolders = fs.readdirSync(commandsPath);

for (const folder of commandFolders) {
  const folderPath = path.join(commandsPath, folder);
  const commandFiles = fs
    .readdirSync(folderPath)
    .filter((file) => file.endsWith(".ts") || file.endsWith(".js"));

  for (const file of commandFiles) {
    const filePath = path.join(folderPath, file);
    const command = require(filePath);
    commands.push(command.data.toJSON());
  }
}

// 從 .env 讀取必要的環境變數
const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;

if (!token || !clientId) {
  throw new Error("DISCORD_TOKEN 或 CLIENT_ID 未在 .env 檔案中設定！");
}

// 建立一個 REST 模組的實例
const rest = new REST({ version: "10" }).setToken(token);

// 立即執行的非同步函式
(async () => {
  try {
    console.log(`正在開始刷新 ${commands.length} 個應用程式 (/) 指令。`);

    // 使用 put 方法將我們的指令完全刷新到所有伺服器
    // Routes.applicationCommands(clientId) 用於全域指令
    const data = await rest.put(Routes.applicationCommands(clientId), {
      body: commands,
    });

    console.log(
      `成功重新載入 ${
        Array.isArray(data) ? data.length : 0
      } 個應用程式 (/) 指令。`
    );
  } catch (error) {
    // 確保能捕捉並印出任何錯誤
    console.error(error);
  }
})();
