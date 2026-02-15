import { Worker, Job } from 'bullmq';
import { createChildLogger } from '../lib/logger';
import { prisma } from '../lib/database';
import { checkRateLimit, getRateLimitDelay } from '../lib/rateLimiter';
import { registerOutgoingHash, isLoopMessage } from '../lib/loopFilter';
import { DiscordClient } from '../platforms/discord/client';
import type { DeliveryJobData } from '../types/canonical';

const log = createChildLogger('discord-delivery-worker');

export class DiscordDeliveryWorker {
  private worker: Worker<DeliveryJobData>;
  private discordClient: DiscordClient;

  constructor(discordClient: DiscordClient) {
    this.discordClient = discordClient;

    this.worker = new Worker<DeliveryJobData>(
      'janus_deliver_discord_*',
      async (job: Job<DeliveryJobData>) => {
        return this.processJob(job);
      },
      {
        connection: { url: process.env.REDIS_URL || 'redis://localhost:6379' },
        concurrency: 5,
      }
    );

    this.worker.on('completed', (job) => {
      log.debug({ jobId: job.id }, 'Discord delivery job completed');
    });

    this.worker.on('failed', (job, err) => {
      log.error({ jobId: job?.id, err }, 'Discord delivery job failed');
    });
  }

  async processJob(job: Job<DeliveryJobData>): Promise<void> {
    const { event, bridgePairId, targetChannelId, discordWebhookId, discordWebhookToken } = job.data;

    log.debug(
      { eventType: event.type, messageId: event.source.messageId, targetChannelId },
      'Processing Discord delivery job'
    );

    const allowed = await checkRateLimit('discord', targetChannelId);
    if (!allowed) {
      const delay = await getRateLimitDelay('discord', targetChannelId);
      await job.moveToDelayed(Date.now() + delay);
      log.warn({ targetChannelId, delay }, 'Rate limited, delaying job');
      return;
    }

    if (!discordWebhookId || !discordWebhookToken) {
      log.error({ bridgePairId }, 'Missing webhook credentials');
      return;
    }

    if (event.type === 'MSG_CREATE') {
      await this.handleMessageCreate(event, targetChannelId, discordWebhookId, discordWebhookToken, bridgePairId);
    } else if (event.type === 'MSG_UPDATE') {
      await this.handleMessageUpdate(event, targetChannelId, discordWebhookId, discordWebhookToken, bridgePairId);
    } else if (event.type === 'MSG_DELETE') {
      await this.handleMessageDelete(event, targetChannelId, discordWebhookId, discordWebhookToken, bridgePairId);
    }
  }

  private async handleMessageCreate(
    event: DeliveryJobData['event'],
    targetChannelId: string,
    webhookId: string,
    webhookToken: string,
    bridgePairId: string
  ): Promise<void> {
    const destMsgId = await this.discordClient.sendWebhook(
      webhookId,
      webhookToken,
      event.content,
      event.author.name,
      event.author.avatar
    );

    if (destMsgId) {
      await prisma.messageMap.create({
        data: {
          pairId: bridgePairId,
          sourcePlatform: event.source.platform,
          sourceMsgId: event.source.messageId,
          destPlatform: 'discord',
          destMsgId,
        },
      });

      await registerOutgoingHash(event.content, event.author.name);
      log.info({ sourceMsgId: event.source.messageId, destMsgId }, 'Message bridged to Discord');
    }
  }

  private async handleMessageUpdate(
    event: DeliveryJobData['event'],
    targetChannelId: string,
    webhookId: string,
    webhookToken: string,
    bridgePairId: string
  ): Promise<void> {
    const messageMap = await prisma.messageMap.findFirst({
      where: {
        pairId: bridgePairId,
        sourcePlatform: event.source.platform,
        sourceMsgId: event.source.messageId,
      },
    });

    if (!messageMap) {
      log.debug({ sourceMsgId: event.source.messageId }, 'No message map found for update');
      return;
    }

    const success = await this.discordClient.editWebhookMessage(
      webhookId,
      webhookToken,
      messageMap.destMsgId,
      event.content
    );

    if (success) {
      log.info({ sourceMsgId: event.source.messageId, destMsgId: messageMap.destMsgId }, 'Message updated on Discord');
    }
  }

  private async handleMessageDelete(
    event: DeliveryJobData['event'],
    targetChannelId: string,
    webhookId: string,
    webhookToken: string,
    bridgePairId: string
  ): Promise<void> {
    const messageMap = await prisma.messageMap.findFirst({
      where: {
        pairId: bridgePairId,
        sourcePlatform: event.source.platform,
        sourceMsgId: event.source.messageId,
      },
    });

    if (!messageMap) {
      log.debug({ sourceMsgId: event.source.messageId }, 'No message map found for deletion');
      return;
    }

    const success = await this.discordClient.deleteWebhookMessage(
      webhookId,
      webhookToken,
      messageMap.destMsgId
    );

    if (success) {
      await prisma.messageMap.delete({ where: { id: messageMap.id } });
      log.info({ sourceMsgId: event.source.messageId, destMsgId: messageMap.destMsgId }, 'Message deleted on Discord');
    }
  }

  async close(): Promise<void> {
    await this.worker.close();
    log.info('Discord delivery worker closed');
  }
}
