import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  Message,
} from "discord.js";
import { redis } from "../../database/redis";

const ITEMS_PER_PAGE = 10;
const CACHE_TTL_SECONDS = 300; // 5 分鐘快取

// ★ 資料獲取函式重構
const getLeaderboardPageData = async (guildId: string, page: number) => {
  const start = (page - 1) * ITEMS_PER_PAGE;
  const end = start + ITEMS_PER_PAGE - 1;
  const leaderboardKey = `leaderboard:${guildId}`;

  // ZREVRANGE: 從 Sorted Set 中按分數從高到低獲取排名
  // 返回的是 [user_id_1, score_1, user_id_2, score_2, ...] 格式的陣列
  const results = await redis.zrevrange(
    leaderboardKey,
    start,
    end,
    "WITHSCORES"
  );

  const data = [];
  for (let i = 0; i < results.length; i += 2) {
    data.push({ user_id: results[i], total_count: results[i + 1] });
  }
  return data;
};

const generateLeaderboardEmbed = async (
  interaction: ChatInputCommandInteraction,
  page: number
): Promise<{ embed: EmbedBuilder; row: ActionRowBuilder<ButtonBuilder> }> => {
  const guildId = interaction.guildId!;
  const leaderboardKey = `leaderboard:${guildId}`;
  const pageCacheKey = `leaderboard:page:${guildId}:${page}`;

  let embedData: any; // 用於儲存 Embed 所需的數據
  const cachedData = await redis.get(pageCacheKey);

  if (cachedData) {
    // ★ 快取命中！直接從 Redis 讀取
    embedData = JSON.parse(cachedData);
  } else {
    // ★ 快取未命中！從 Redis Sorted Set (或 PostgreSQL) 計算

    const totalUsers = await redis.zcard(leaderboardKey); // ZCARD: 獲取 Sorted Set 的成員總數
    const totalPages = Math.ceil(totalUsers / ITEMS_PER_PAGE) || 1;

    const rows = await getLeaderboardPageData(guildId, page);

    const userRank = await redis.zrevrank(leaderboardKey, interaction.user.id); // ZREVRANK: 獲取成員的排名 (從 0 開始)

    const description = rows
      .map((row, index) => {
        const rank = (page - 1) * ITEMS_PER_PAGE + index + 1;
        return `${rank}. <@${row.user_id}> - **${row.total_count}** 則訊息`;
      })
      .join("\n");

    embedData = {
      description:
        description.length > 0 ? description : "這個伺服器還沒有訊息紀錄！",
      footer: {
        text: `你的排名: ${userRank !== null ? userRank + 1 : "N/A"} | 你在第 ${
          userRank !== null ? Math.ceil((userRank + 1) / ITEMS_PER_PAGE) : "N/A"
        } 頁`,
      },
      totalPages: totalPages,
    };

    // 將新生成的數據寫入快取，並設置 TTL
    await redis.set(
      pageCacheKey,
      JSON.stringify(embedData),
      "EX",
      CACHE_TTL_SECONDS
    );
  }

  const embed = new EmbedBuilder()
    .setTitle(`👑 ${interaction.guild!.name} 訊息排行榜 (高速版)`)
    .setColor("Gold")
    .setDescription(embedData.description)
    .setFooter(embedData.footer);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("prev_page")
      .setLabel("◀️ 上一頁")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(page === 1),
    new ButtonBuilder()
      .setCustomId("page_status")
      .setLabel(`${page} / ${embedData.totalPages}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId("next_page")
      .setLabel("下一頁 ▶️")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(page === embedData.totalPages)
  );

  return { embed, row };
};

module.exports = {
  data: new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("顯示伺服器訊息排行榜"),

  async execute(interaction: ChatInputCommandInteraction) {
    if (!interaction.guild) return;

    let currentPage = 1;
    const initialData = await generateLeaderboardEmbed(
      interaction,
      currentPage
    );

    const response: Message = await interaction.reply({
      embeds: [initialData.embed],
      components: [initialData.row],
      fetchReply: true,
    });

    const collector = response.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 300_000,
    });

    collector.on("collect", async (i) => {
      if (i.user.id !== interaction.user.id) {
        await i.reply({ content: "這不是給你的按鈕！", ephemeral: true });
        return;
      }

      if (i.customId === "prev_page") {
        currentPage--;
      } else if (i.customId === "next_page") {
        currentPage++;
      }

      const newData = await generateLeaderboardEmbed(interaction, currentPage);
      await i.update({
        embeds: [newData.embed],
        components: [newData.row],
      });
    });

    collector.on("end", async () => {
      const finalData = await generateLeaderboardEmbed(
        interaction,
        currentPage
      );
      await response.edit({ components: [] });
    });
  },
};
