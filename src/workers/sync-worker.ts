import { parentPort, workerData } from "worker_threads";
import {
  Client,
  GatewayIntentBits,
  ChannelType,
  TextChannel,
  NewsChannel,
  AnyThreadChannel,
} from "discord.js";
import { MessageCount } from "../database";

type WorkerData = {
  channelIds: string[];
  token: string;
  guildId: string;
};

type WorkerResult = {
  counts: MessageCount[];
  error?: string;
};

if (!parentPort) {
  throw new Error("This script must be run as a worker thread.");
}

const { channelIds, token, guildId } = workerData as WorkerData;

const processChannels = async () => {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  await client.login(token);

  const guild = await client.guilds.fetch(guildId);
  if (!guild) {
    parentPort?.postMessage({ error: "Guild not found." });
    return;
  }

  const counts: MessageCount[] = [];
  const messageCounts: { [key: string]: number } = {};

  for (const channelId of channelIds) {
    try {
      const channel = await guild.channels.fetch(channelId);

      if (
        !channel ||
        (channel.type !== ChannelType.GuildText &&
          channel.type !== ChannelType.GuildNews &&
          channel.type !== ChannelType.PrivateThread &&
          channel.type !== ChannelType.PublicThread)
      ) {
        continue;
      }

      const fetchableChannel = channel as
        | TextChannel
        | NewsChannel
        | AnyThreadChannel;
      let lastId: string | undefined;
      let messagesProcessed = 0;

      while (true) {
        const messages = await fetchableChannel.messages.fetch({
          limit: 100,
          before: lastId,
        });

        if (messages.size === 0) {
          break;
        }

        for (const message of messages.values()) {
          if (message.author.bot) continue;

          const date = message.createdAt.toISOString().slice(0, 10); // YYYY-MM-DD
          const key = `${message.author.id}:${channel.id}:${date}`;
          messageCounts[key] = (messageCounts[key] || 0) + 1;
        }

        lastId = messages.last()?.id;
        if (!lastId) {
          break;
        }

        messagesProcessed += messages.size;
        // Optional: report progress back to the main thread
        // parentPort?.postMessage({ type: 'progress', channelId, messagesProcessed });
      }
    } catch (error) {
      console.error(`Error fetching messages for channel ${channelId}:`, error);
      // Optionally report error for this specific channel
      // parentPort?.postMessage({ type: 'error', channelId, error: (error as Error).message });
    }
  }

  for (const key in messageCounts) {
    const [userId, channelId, date] = key.split(":");
    counts.push({
      user_id: userId,
      guild_id: guildId,
      channel_id: channelId,
      message_date: date,
      count: messageCounts[key],
    });
  }

  parentPort?.postMessage({ counts } as WorkerResult);
  await client.destroy();
  process.exit(0);
};

processChannels().catch((err) => {
  parentPort?.postMessage({ error: (err as Error).message } as WorkerResult);
  process.exit(1);
});
