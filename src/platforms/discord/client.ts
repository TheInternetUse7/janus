import { Client, GatewayIntentBits, Events, Message, Guild, TextChannel, NewsChannel, Webhook } from 'discord.js';
import { EventEmitter } from 'events';
import { createChildLogger } from '../../lib/logger';
import { config } from '../../config';

const log = createChildLogger('discord-client');

export interface DiscordMessageEvent {
  id: string;
  channelId: string;
  guildId: string | null;
  content: string;
  author: {
    id: string;
    username: string;
    bot: boolean;
    avatar: string | null;
  };
  attachments: Array<{
    url: string;
    filename: string;
    contentType: string | null;
    size: number;
  }>;
  editedAt: Date | null;
  timestamp: string;
}

export class DiscordClient extends EventEmitter {
  private client: Client;
  private ready = false;

  constructor() {
    super();
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    this.client.once(Events.ClientReady, () => {
      this.ready = true;
      log.info(
        { guilds: this.client.guilds.cache.size },
        'Discord client ready'
      );
    });

    this.client.on(Events.MessageCreate, (message: Message) => {
      if (message.author?.bot) return;
      if (!message.guildId) return;

      const event = this.normalizeMessage(message, 'MSG_CREATE');
      this.emit('message', event);
    });

    this.client.on(Events.MessageUpdate, (_oldMessage, newMessage) => {
      if (newMessage.author?.bot) return;
      if (!newMessage.guildId) return;
      if (!newMessage.content) return;

      const event = this.normalizeMessage(newMessage as Message, 'MSG_UPDATE');
      this.emit('messageUpdate', event);
    });

    this.client.on(Events.MessageDelete, (_message) => {
      const message = _message as Message;
      if (message.author?.bot) return;
      if (!message.guildId) return;

      this.emit('messageDelete', {
        id: message.id,
        channelId: message.channelId,
        guildId: message.guildId,
      });
    });

    this.client.on(Events.GuildCreate, (guild: Guild) => {
      log.info({ guildId: guild.id, name: guild.name }, 'Joined guild');
    });

    this.client.on(Events.GuildDelete, (guild: Guild) => {
      log.info({ guildId: guild.id, name: guild.name }, 'Left/kicked from guild');
    });

    this.client.on(Events.Error, (error: Error) => {
      log.error({ error }, 'Discord client error');
    });
  }

  private normalizeMessage(
    message: Message,
    type: 'MSG_CREATE' | 'MSG_UPDATE'
  ): DiscordMessageEvent {
    return {
      id: message.id,
      channelId: message.channelId,
      guildId: message.guildId,
      content: message.content,
      author: {
        id: message.author?.id ?? 'unknown',
        username: message.author?.username ?? 'unknown',
        bot: message.author?.bot ?? false,
        avatar: message.author?.displayAvatarURL({ size: 128 }) ?? null,
      },
      attachments: message.attachments.map((att) => ({
        url: att.url,
        filename: att.name ?? 'unknown',
        contentType: att.contentType,
        size: att.size,
      })),
      editedAt: message.editedAt,
      timestamp: message.createdAt.toISOString(),
    };
  }

  async connect(): Promise<void> {
    log.info('Connecting to Discord...');
    await this.client.login(config.discord.token);
  }

  disconnect(): void {
    this.client.destroy();
    log.info('Discord client disconnected');
  }

  isReady(): boolean {
    return this.ready;
  }

  getClient(): Client {
    return this.client;
  }

  async fetchChannel(channelId: string): Promise<TextChannel | NewsChannel | null> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (channel instanceof TextChannel || channel instanceof NewsChannel) {
        return channel;
      }
      return null;
    } catch (error) {
      log.error({ channelId, error }, 'Failed to fetch channel');
      return null;
    }
  }

  async fetchWebhook(channelId: string): Promise<{ id: string; token: string } | null> {
    try {
      const channel = await this.fetchChannel(channelId);
      if (!channel) return null;

      const webhooks = await channel.fetchWebhooks();
      const webhook = webhooks.first();
      
      if (webhook) {
        return { id: webhook.id, token: webhook.token! };
      }
      return null;
    } catch (error) {
      log.error({ channelId, error }, 'Failed to fetch webhook');
      return null;
    }
  }

  async createWebhook(channelId: string, name: string): Promise<{ id: string; token: string } | null> {
    try {
      const channel = await this.fetchChannel(channelId);
      if (!channel) return null;

      const webhook = await channel.createWebhook({ name });
      return { id: webhook.id, token: webhook.token! };
    } catch (error) {
      log.error({ channelId, error }, 'Failed to create webhook');
      return null;
    }
  }

  async sendWebhook(
    webhookId: string,
    webhookToken: string,
    content: string,
    username: string,
    avatarUrl: string | null
  ): Promise<string | null> {
    try {
      const webhook = await this.client.fetchWebhook(webhookId, webhookToken);
      if (!webhook) return null;

      const message = await webhook.send({
        content,
        username,
        avatarURL: avatarUrl ?? undefined,
      });

      return message.id;
    } catch (error) {
      log.error({ webhookId, error }, 'Failed to send webhook');
      return null;
    }
  }

  async editWebhookMessage(
    webhookId: string,
    webhookToken: string,
    messageId: string,
    content: string
  ): Promise<boolean> {
    try {
      const webhook = await this.client.fetchWebhook(webhookId, webhookToken);
      if (!webhook) return false;

      await webhook.editMessage(messageId, { content });
      return true;
    } catch (error) {
      log.error({ webhookId, messageId, error }, 'Failed to edit webhook message');
      return false;
    }
  }

  async deleteWebhookMessage(
    webhookId: string,
    webhookToken: string,
    messageId: string
  ): Promise<boolean> {
    try {
      const webhook = await this.client.fetchWebhook(webhookId, webhookToken);
      if (!webhook) return false;

      await webhook.deleteMessage(messageId);
      return true;
    } catch (error) {
      log.error({ webhookId, messageId, error }, 'Failed to delete webhook message');
      return false;
    }
  }
}
