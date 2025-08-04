import { Events, Interaction } from "discord.js";

module.exports = {
  name: Events.InteractionCreate,
  async execute(interaction: Interaction) {
    // 我們只處理斜線指令 (ChatInputCommand)
    if (!interaction.isChatInputCommand()) return;

    // 從 interaction.client (也就是我們的 client 實例) 的 commands 集合中
    // 根據指令名稱取得對應的指令物件
    const command = interaction.client.commands.get(interaction.commandName);

    // 如果找不到指令，印出錯誤並返回
    if (!command) {
      console.error(`找不到名稱為 ${interaction.commandName} 的指令。`);
      return;
    }

    try {
      // 執行指令的 execute 方法
      await command.execute(interaction);
    } catch (error) {
      console.error(`執行指令 ${interaction.commandName} 時發生錯誤:`, error);
      // 向使用者回覆一個錯誤訊息
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({
          content: "執行此指令時發生錯誤！",
          ephemeral: true,
        });
      } else {
        await interaction.reply({
          content: "執行此指令時發生錯誤！",
          ephemeral: true,
        });
      }
    }
  },
};
