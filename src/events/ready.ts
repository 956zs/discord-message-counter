import { Events, Client } from "discord.js";

module.exports = {
  name: Events.ClientReady,
  once: true, // 這個事件只會觸發一次
  execute(client: Client) {
    if (client.user) {
      console.log(`準備完成！已登入為 ${client.user.tag}`);
    } else {
      console.log(`準備完成！但無法取得使用者資訊。`);
    }
  },
};
