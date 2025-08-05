import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  ChannelType,
  TextChannel,
} from "discord.js";
import { pool } from "../../database";
import { redis } from "../../database/redis";

const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));

module.exports = {
  data: new SlashCommandBuilder()
    .setName("sync-missing")
    .setDescription("【快速】掃描並補全機器人下線期間遺漏的訊息")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction: ChatInputCommandInteraction) {
    if (!interaction.guild || !interaction.user) {
      return interaction.reply({
        content: "此指令發生了非預期的錯誤。",
        ephemeral: true,
      });
    }

    await interaction.deferReply({ ephemeral: true });

    const guild = interaction.guild;
    const dbClient = await pool.connect();
    let totalSynced = 0;
    const lockKey = `sync-lock:${interaction.guildId}`;
    const lockTimeout = 3600; // 1 hour

    // Try to acquire lock
    const acquiredLock = await redis.set(
      lockKey,
      interaction.user.id,
      "EX",
      lockTimeout,
      "NX"
    );

    if (!acquiredLock) {
      const holderId = await redis.get(lockKey);
      return interaction.editReply({
        content: `❌ 目前已有一個同步任務正在由 <@${holderId}> 執行中，請稍後再試。`,
      });
    }

    try {
      // 1. 獲取增量同步的錨點
      const statusRes = await dbClient.query(
        "SELECT last_known_message_id FROM sync_status WHERE guild_id = $1",
        [guild.id]
      );
      const lastKnownId = statusRes.rows[0]?.last_known_message_id;

      if (!lastKnownId) {
        return interaction.editReply({
          content:
            "❌ 找不到同步錨點。請先執行一次 `/sync-full` 來完成伺服器初始化。",
        });
      }

      await interaction.editReply(
        `✅ 找到同步錨點，將從訊息 ID \`${lastKnownId}\` 之後開始掃描...`
      );

      const channels = guild.channels.cache.filter(
        (ch): ch is TextChannel =>
          ch.type === ChannelType.GuildText && ch.viewable
      );

      // 2. 遍歷所有頻道，抓取 'after' 的訊息
      for (const channel of channels.values()) {
        let lastFetchedId: string | undefined = lastKnownId;
        let channelSynced = 0;

        while (true) {
          const messages = await channel.messages.fetch({
            after: lastFetchedId,
            limit: 100,
          });
          if (messages.size === 0) break;

          const counts: { [userId: string]: number } = {};
          for (const msg of messages.values()) {
            if (msg.author.bot) continue;
            counts[msg.author.id] = (counts[msg.author.id] || 0) + 1;
          }

          if (Object.keys(counts).length > 0) {
            await dbClient.query("BEGIN");
            for (const userId in counts) {
              const query = `
                INSERT INTO message_counts (user_id, guild_id, channel_id, count) VALUES ($1, $2, $3, $4)
                ON CONFLICT (user_id, guild_id, channel_id) DO UPDATE SET count = message_counts.count + $4;
              `;
              await dbClient.query(query, [
                userId,
                guild.id,
                channel.id,
                counts[userId],
              ]);
            }
            await dbClient.query("COMMIT");
          }

          channelSynced += messages.filter((m) => !m.author.bot).size;
          // 注意：增量同步是從舊到新，所以要取 firstKey
          lastFetchedId = messages.first()!.id;
        }
        totalSynced += channelSynced;
        await delay(500); // 頻道間短暫延遲
      }

      // 3. 更新錨點到最新訊息
      const latestMessage = guild.channels.cache
        .filter(
          (ch): ch is TextChannel =>
            ch.type === ChannelType.GuildText &&
            ch.viewable &&
            ch.lastMessageId !== null
        )
        .map((ch) => ({
          id: ch.lastMessageId!,
          createdTimestamp: ch.lastMessage?.createdTimestamp ?? 0,
        }))
        .sort((a, b) => b.createdTimestamp - a.createdTimestamp)[0];

      if (latestMessage) {
        await dbClient.query(
          "UPDATE sync_status SET last_known_message_id = $1 WHERE guild_id = $2",
          [latestMessage.id, guild.id]
        );
      }

      await interaction.followUp({
        content: `✅ 增量同步完成！共補全了 **${totalSynced}** 則遺漏的訊息。`,
        ephemeral: true,
      });
    } catch (error) {
      console.error("執行 sync-missing 時發生錯誤:", error);
      await interaction.followUp({
        content: "❌ 增量同步失敗，請檢查後台日誌。",
        ephemeral: true,
      });
    } finally {
      dbClient.release();
      // ★ Always release the lock
      await redis.del(lockKey);
    }
  },
};
