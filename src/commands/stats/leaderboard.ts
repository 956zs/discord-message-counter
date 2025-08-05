import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  Message,
  ChannelType,
  MessageFlags,
} from "discord.js";
import { redis } from "../../database/redis";
import { pool } from "../../database";

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

const getFilteredLeaderboardFromDB = async (
  guildId: string,
  page: number,
  userId: string,
  channelId?: string,
  date?: string | null
) => {
  const offset = (page - 1) * ITEMS_PER_PAGE;
  const whereClauses: string[] = ["guild_id = $1"];
  const values: (string | number)[] = [guildId];
  let valueCounter = 2;

  if (channelId) {
    whereClauses.push(`channel_id = $${valueCounter++}`);
    values.push(channelId);
  }
  if (date) {
    whereClauses.push(`message_date = $${valueCounter++}`);
    values.push(date);
  }

  const whereString = whereClauses.join(" AND ");

  const dataQuery = `
    SELECT user_id, SUM(count)::bigint as total_count
    FROM message_counts
    WHERE ${whereString}
    GROUP BY user_id
    ORDER BY total_count DESC
    LIMIT ${ITEMS_PER_PAGE}
    OFFSET ${offset};
  `;

  const totalQuery = `SELECT COUNT(DISTINCT user_id) as total_users FROM message_counts WHERE ${whereString};`;

  const rankQuery = `
    WITH user_ranks AS (
      SELECT user_id, RANK() OVER (ORDER BY SUM(count) DESC) as rank
      FROM message_counts
      WHERE ${whereString}
      GROUP BY user_id
    )
    SELECT rank FROM user_ranks WHERE user_id = $${valueCounter};
  `;
  values.push(userId);

  const client = await pool.connect();
  try {
    const [dataResult, totalResult, rankResult] = await Promise.all([
      client.query(dataQuery, values.slice(0, valueCounter - 1)),
      client.query(totalQuery, values.slice(0, valueCounter - 1)),
      client.query(rankQuery, values),
    ]);

    return {
      rows: dataResult.rows,
      totalCount: parseInt(totalResult.rows[0]?.total_users || "0", 10),
      userRank: rankResult.rows[0]
        ? parseInt(rankResult.rows[0].rank, 10)
        : null,
    };
  } finally {
    client.release();
  }
};

const generateLeaderboardEmbed = async (
  interaction: ChatInputCommandInteraction,
  page: number
): Promise<{ embed: EmbedBuilder; row: ActionRowBuilder<ButtonBuilder> }> => {
  const guildId = interaction.guildId!;
  const channel = interaction.options.getChannel("channel");
  const date = interaction.options.getString("date");

  // --- Dynamic Cache Key ---
  const filterSuffix = `${channel ? `_ch:${channel.id}` : ""}${
    date ? `_date:${date}` : ""
  }`;
  const pageCacheKey = `leaderboard:page:${guildId}:${page}${filterSuffix}`;

  let embedData: any;
  const cachedData = await redis.get(pageCacheKey);

  if (cachedData) {
    embedData = JSON.parse(cachedData);
  } else {
    // --- Data Fetching Logic ---
    let rows, totalUsers, userRank;

    if (channel || date) {
      // ** DB-based filtered leaderboard **
      const {
        rows: dbRows,
        totalCount,
        userRank: dbUserRank,
      } = await getFilteredLeaderboardFromDB(
        guildId,
        page,
        interaction.user.id,
        channel?.id,
        date
      );
      rows = dbRows;
      totalUsers = totalCount;
      userRank = dbUserRank;
    } else {
      // ** Redis-based global leaderboard **
      const leaderboardKey = `leaderboard:${guildId}`;
      rows = await getLeaderboardPageData(guildId, page);
      totalUsers = await redis.zcard(leaderboardKey);
      const rank = await redis.zrevrank(leaderboardKey, interaction.user.id);
      userRank = rank !== null ? rank + 1 : null;
    }

    const totalPages = Math.ceil(totalUsers / ITEMS_PER_PAGE) || 1;

    const description = rows
      .map((row: any, index: number) => {
        const rank = (page - 1) * ITEMS_PER_PAGE + index + 1;
        return `${rank}. <@${row.user_id}> - **${row.total_count}** 則訊息`;
      })
      .join("\n");

    embedData = {
      description:
        description.length > 0 ? description : "找不到符合條件的訊息紀錄！",
      footer: {
        text: `你的排名: ${userRank || "N/A"} | 你在第 ${
          userRank ? Math.ceil(userRank / ITEMS_PER_PAGE) : "N/A"
        } 頁`,
      },
      totalPages: totalPages,
      title: `👑 ${interaction.guild!.name} ${
        channel ? `#${channel.name} ` : ""
      }${date ? `${date} ` : ""}訊息排行榜`,
    };

    await redis.set(
      pageCacheKey,
      JSON.stringify(embedData),
      "EX",
      CACHE_TTL_SECONDS
    );
  }

  const embed = new EmbedBuilder()
    .setTitle(`👑 ${interaction.guild!.name} 訊息排行榜`)
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
    .setDescription("顯示伺服器訊息排行榜")
    .addChannelOption((option) =>
      option
        .setName("channel")
        .setDescription("只看特定頻道的排行榜")
        .addChannelTypes(
          ChannelType.GuildText,
          ChannelType.GuildVoice,
          ChannelType.GuildAnnouncement
        )
        .setRequired(false)
    )
    .addStringOption((option) =>
      option
        .setName("date")
        .setDescription("只看特定日期的排行榜 (格式: YYYY-MM-DD)")
        .setRequired(false)
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    if (!interaction.guild) return;

    let currentPage = 1;
    const initialData = await generateLeaderboardEmbed(
      interaction,
      currentPage
    );

    await interaction.reply({
      embeds: [initialData.embed],
      components: [initialData.row],
    });
    const response = await interaction.fetchReply();

    const collector = response.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 300_000,
    });

    collector.on("collect", async (i) => {
      if (i.user.id !== interaction.user.id) {
        await i.reply({
          content: "這不是給你的按鈕！",
          flags: MessageFlags.Ephemeral,
        });
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
