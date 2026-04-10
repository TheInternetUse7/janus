import { Client, Events, Routes, Webhook } from '@fluxerjs/core';
import { EventEmitter } from 'events';
import { createChildLogger } from '../../lib/logger';
import { bridgeService } from '../../lib/bridge';

const log = createChildLogger('fluxer-client');

export interface FluxerMessage {
  id: string;
  channelId: string;
  guildId?: string | null;
  content: string;
  author: {
    id: string;
    name: string;
    avatar: string | null;
    bot: boolean;
  };
  reference?: {
    messageId: string;
    channelId?: string;
    guildId?: string | null;
  } | null;
  attachments: Array<{
    url: string;
    filename: string;
    contentType: string | null;
    size: number;
  }>;
  timestamp: string;
  editedAt: string | null;
}

interface PendingWebhookMessage {
  channelId: string;
  content: string;
  username: string;
  timestamp: number;
  resolve: (messageId: string) => void;
  timeout: NodeJS.Timeout;
}

export class FluxerClient extends EventEmitter {
  private client: Client;
  private ready = false;
  private pendingWebhookMessages: Map<string, PendingWebhookMessage> = new Map();

  constructor() {
    super();

    this.client = new Client({
      intents: 0,
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    this.client.on(Events.Ready, () => {
      this.ready = true;
      log.info({ username: this.client.user?.username }, 'Fluxer client ready');
    });

    const getChannelId = (data: any) => data.channelId || data.channel_id;
    const getGuildId = (data: any) => data.guildId || data.guild_id;
    const getMessageReference = (data: any) => {
      const reference = data.messageReference || data.message_reference;
      const messageId = reference?.messageId || reference?.message_id;
      if (!messageId) return null;
      return {
        messageId,
        channelId: reference.channelId || reference.channel_id || undefined,
        guildId: reference.guildId || reference.guild_id || null,
      };
    };
    const getAttachments = (data: any) =>
      (data.attachments ?? []).map((att: any) => ({
        url: att.url ?? '',
        filename: att.filename ?? 'unknown',
        contentType: att.content_type ?? null,
        size: att.size ?? 0,
      }));

    this.client.on(Events.MessageCreate, async (data: any) => {
      const channelId = getChannelId(data);
      const guildId = getGuildId(data);
      const reference = getMessageReference(data);
      const attachments = getAttachments(data);
      const content = typeof data.content === 'string' ? data.content : '';

      // Check if this message matches a pending webhook send
      const pendingKey = this.findPendingWebhookMessage(channelId, content, data.author?.username);
      if (pendingKey) {
        const pending = this.pendingWebhookMessages.get(pendingKey);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingWebhookMessages.delete(pendingKey);
          pending.resolve(data.id);
          log.debug({ messageId: data.id, channelId }, 'Captured webhook message ID');
          // Don't emit this message as a regular message event since it's our own webhook
          return;
        }
      }

      if (data.author?.bot) return;
      if (!content.trim() && attachments.length === 0 && !reference) return;

      const fluxerMessage: FluxerMessage = {
        id: data.id,
        channelId: channelId,
        guildId: guildId,
        content,
        author: {
          id: data.author?.id ?? 'unknown',
          name: data.author?.username ?? 'unknown',
          avatar: data.author?.avatar ?? data.author?.avatar_url ?? null,
          bot: data.author?.bot ?? false,
        },
        reference,
        attachments,
        timestamp: data.timestamp ?? new Date().toISOString(),
        editedAt: data.edited_timestamp ?? null,
      };

      if (content.startsWith('!bridge ')) {
        const args = content.slice(8).trim().split(/\s+/);
        const command = args.shift()?.toLowerCase();

        try {
          if (command === 'create') {
            const discordChannelId = args[0];
            if (!discordChannelId) {
              await this.sendMessage(channelId, {
                content: 'Usage: !bridge create <discord_channel_id>',
              });
              return;
            }
            const bridge = await bridgeService.createBridge(
              discordChannelId,
              channelId,
              'UNKNOWN_DISCORD_GUILD',
              guildId
            );
            await this.sendMessage(channelId, { content: `Bridge created! ID: ${bridge.id}` });
          } else if (command === 'list') {
            const bridges = await bridgeService.listBridges(undefined, guildId);
            if (bridges.length === 0) {
              await this.sendMessage(channelId, { content: 'No active bridges found.' });
            } else {
              const list = bridges
                .map(
                  (b) =>
                    `- Discord: ${b.discordChannelId} <-> Fluxer: ${b.fluxerChannelId} (ID: ${b.id})`
                )
                .join('\n');
              await this.sendMessage(channelId, { content: `Active Bridges:\n${list}` });
            }
          } else if (command === 'delete') {
            const bridgeId = args[0];
            if (!bridgeId) {
              await this.sendMessage(channelId, { content: 'Usage: !bridge delete <bridge_id>' });
              return;
            }
            await bridgeService.deleteBridge(bridgeId);
            await this.sendMessage(channelId, { content: `Bridge ${bridgeId} deleted.` });
          } else if (command === 'toggle') {
            const bridgeId = args[0];
            const active = args[1] === 'true' || args[1] === 'on' || args[1] === '1';

            if (!bridgeId) {
              await this.sendMessage(channelId, {
                content: 'Usage: !bridge toggle <bridge_id> <true/false>',
              });
              return;
            }

            await bridgeService.toggleBridge(bridgeId, active);
            await this.sendMessage(data.channel_id, {
              content: `Bridge ${bridgeId} is now ${active ? 'active' : 'inactive'}.`,
            });
          }
        } catch (error: any) {
          log.error({ error }, 'Failed to execute bridge command');
          try {
            let content = 'An error occurred while executing the command.';
            if (error instanceof Error && error.message.startsWith('Bridge validation failed:')) {
              content = error.message;
            }
            await this.sendMessage(channelId, { content });
          } catch (sendError) {
            log.error({ sendError }, 'Failed to send error message to Fluxer');
          }
        }
        return; // Don't emit message event for commands
      }

      this.emit('message', fluxerMessage);
    });

    this.client.on(Events.MessageUpdate, async (_oldMessage: any, newMessage: any) => {
      if (newMessage.author?.bot) return;

      const channelId = getChannelId(newMessage);
      const guildId = getGuildId(newMessage);
      const reference = getMessageReference(newMessage);
      const attachments = getAttachments(newMessage);
      const content = typeof newMessage.content === 'string' ? newMessage.content : '';
      if (!content.trim() && attachments.length === 0 && !reference) return;

      const fluxerMessage: FluxerMessage = {
        id: newMessage.id,
        channelId: channelId,
        guildId: guildId,
        content,
        author: {
          id: newMessage.author?.id ?? 'unknown',
          name: newMessage.author?.username ?? 'unknown',
          avatar: newMessage.author?.avatar ?? newMessage.author?.avatar_url ?? null,
          bot: newMessage.author?.bot ?? false,
        },
        reference,
        attachments,
        timestamp:
          newMessage.createdAt?.toISOString?.() ?? newMessage.timestamp ?? new Date().toISOString(),
        editedAt: newMessage.editedAt?.toISOString?.() ?? newMessage.edited_timestamp ?? null,
      };
      this.emit('messageUpdate', fluxerMessage);
    });

    this.client.on(Events.MessageDelete, async (data: any) => {
      this.emit('messageDelete', {
        id: data.id,
        channelId: getChannelId(data),
        guildId: getGuildId(data),
      });
    });

    this.client.on(Events.Error, (error: Error) => {
      log.error({ error }, 'Fluxer client error');
    });
  }

  async connect(token: string): Promise<void> {
    log.info('Connecting to Fluxer');
    await this.client.login(token);
  }

  disconnect(): void {
    this.client.destroy();
    log.info('Fluxer client disconnected');
  }

  isReady(): boolean {
    return this.ready;
  }

  async sendMessage(
    channelId: string,
    payload: {
      content: string;
      masquerade?: { name: string; avatar: string };
      files?: Array<{ name: string; data: Buffer }>;
    }
  ): Promise<{ id: string }> {
    log.debug(
      { channelId, hasContent: !!payload.content, fileCount: payload.files?.length ?? 0 },
      'Sending message to Fluxer'
    );

    const messageData: Record<string, unknown> = {
      content: payload.content,
    };

    if (payload.masquerade) {
      messageData.username = payload.masquerade.name;
      messageData.avatar_url = payload.masquerade.avatar;
    }

    const postOptions: Record<string, unknown> = {
      body: messageData,
    };
    if (payload.files?.length) {
      messageData.attachments = payload.files.map((file, index) => ({
        id: index,
        filename: file.name,
      }));
      postOptions.files = payload.files.map((file) => ({
        name: file.name,
        data: file.data,
        filename: file.name,
      }));
    }

    const result = await this.client.rest.post(
      Routes.channelMessages(channelId),
      postOptions as any
    );
    return { id: (result as any).id };
  }

  async editMessage(messageId: string, channelId: string, content: string): Promise<void> {
    log.debug({ messageId, channelId }, 'Editing message on Fluxer');
    await this.client.rest.patch(Routes.channelMessage(channelId, messageId), {
      body: { content },
    });
  }

  async deleteMessage(messageId: string, channelId: string): Promise<void> {
    log.debug({ messageId, channelId }, 'Deleting message on Fluxer');
    await this.client.rest.delete(Routes.channelMessage(channelId, messageId));
  }

  async fetchWebhook(channelId: string): Promise<{ id: string; token: string } | null> {
    try {
      const webhooks = await this.client.rest.get(Routes.channelWebhooks(channelId));
      const webhook = (webhooks as any[])[0];
      if (webhook) {
        return { id: webhook.id, token: webhook.token ?? '' };
      }
      return null;
    } catch (error) {
      log.error({ channelId, error }, 'Failed to fetch webhook');
      return null;
    }
  }

  async createWebhook(
    channelId: string,
    name: string
  ): Promise<{ id: string; token: string } | null> {
    try {
      const webhook = await this.client.rest.post(Routes.channelWebhooks(channelId), {
        body: { name },
      });
      return { id: (webhook as any).id, token: (webhook as any).token ?? '' };
    } catch (error) {
      log.error({ channelId, error }, 'Failed to create webhook');
      return null;
    }
  }

  private findPendingWebhookMessage(
    channelId: string,
    content: string | undefined,
    username: string
  ): string | null {
    const normalizedContent = content ?? '';
    // Look for a pending webhook message that matches this channel, content, and username
    for (const [key, pending] of this.pendingWebhookMessages.entries()) {
      if (
        pending.channelId === channelId &&
        pending.content === normalizedContent &&
        pending.username === username
      ) {
        return key;
      }
    }
    return null;
  }

  async sendWebhook(
    webhookId: string,
    webhookToken: string,
    content: string,
    username: string,
    avatarUrl: string | null,
    channelId?: string,
    files?: Array<{ name: string; data: Buffer }>
  ): Promise<string | null> {
    let pendingKey: string | null = null;
    const normalizedContent = content.trim();

    try {
      const webhook = Webhook.fromToken(this.client, webhookId, webhookToken, {
        channelId,
      });

      const payload: any = {
        username,
      };
      if (normalizedContent) {
        payload.content = content;
      }

      if (avatarUrl) {
        payload.avatar_url = avatarUrl;
      }
      if (files?.length) {
        payload.files = files.map((file) => ({
          name: file.name,
          data: file.data,
          filename: file.name,
        }));
      }
      log.debug(
        {
          webhookId,
          channelId,
          hasContent: !!normalizedContent,
          fileCount: files?.length ?? 0,
        },
        'Sending webhook payload to Fluxer'
      );

      // Create a promise that will be resolved when we receive the message event
      const messageIdPromise = channelId
        ? new Promise<string | null>((resolve) => {
            const key = `${channelId}-${Date.now()}-${Math.random()}`;
            pendingKey = key;
            const timeout = setTimeout(() => {
              this.pendingWebhookMessages.delete(key);
              log.warn({ webhookId, channelId }, 'Timeout waiting for webhook message ID');
              resolve(null);
            }, 5000); // 5 second timeout

            this.pendingWebhookMessages.set(key, {
              channelId,
              content: normalizedContent ? content : '',
              username,
              timestamp: Date.now(),
              resolve,
              timeout,
            });
          })
        : Promise.resolve(null);

      // Request the created message directly when possible.
      // Keep pending matcher alive briefly to suppress self-ingest if gateway event arrives later.
      const sentMessage = await webhook.send(payload);
      const responseMessageId = sentMessage?.id ?? null;
      if (responseMessageId && pendingKey) {
        const key = pendingKey;
        const pending = this.pendingWebhookMessages.get(pendingKey);
        if (pending) {
          clearTimeout(pending.timeout);
          pending.timeout = setTimeout(() => {
            this.pendingWebhookMessages.delete(key);
          }, 5000);
          pending.resolve(responseMessageId);
        }
      }

      // Fallback to gateway capture when execute response did not include a message.
      const messageId = responseMessageId ?? (await messageIdPromise);

      if (messageId) {
        log.debug({ webhookId, username, messageId }, 'Webhook sent successfully with captured ID');
      } else {
        log.debug({ webhookId, username }, 'Webhook sent successfully (no ID captured)');
      }

      return messageId;
    } catch (error) {
      if (pendingKey) {
        const pending = this.pendingWebhookMessages.get(pendingKey);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingWebhookMessages.delete(pendingKey);
        }
      }
      log.error(
        {
          webhookId,
          channelId,
          error:
            error instanceof Error
              ? {
                  name: error.name,
                  message: error.message,
                  stack: error.stack,
                }
              : error,
        },
        'Failed to send webhook'
      );
      return null;
    }
  }
}
