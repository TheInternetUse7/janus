import { Worker, Job } from 'bullmq';
import { createChildLogger } from '../lib/logger';
import { prisma } from '../lib/database';
import { checkRateLimit, getRateLimitDelay } from '../lib/rateLimiter';
import { registerOutgoingHash } from '../lib/loopFilter';
import { getRedisConnection } from '../lib/redis';
import { FluxerClient } from '../platforms/fluxer/client';
import type { DeliveryJobData } from '../types/canonical';

const log = createChildLogger('fluxer-delivery-worker');
const EDIT_UPDATE_TTL_SECONDS = parseInt(
  process.env.FLUXER_EDIT_UPDATE_TTL_SECONDS || '604800',
  10
);

export class FluxerDeliveryWorker {
  private worker: Worker<DeliveryJobData>;
  private fluxerClient: FluxerClient;

  constructor(fluxerClient: FluxerClient, channelId: string) {
    this.fluxerClient = fluxerClient;

    this.worker = new Worker<DeliveryJobData>(
      `janus_deliver_fluxer_${channelId}`,
      async (job: Job<DeliveryJobData>) => {
        return this.processJob(job);
      },
      {
        connection: { url: process.env.REDIS_URL || 'redis://localhost:6379' },
        concurrency: 5,
      }
    );

    this.worker.on('completed', (job) => {
      log.debug({ jobId: job.id }, 'Fluxer delivery job completed');
    });

    this.worker.on('failed', (job, err) => {
      log.error({ jobId: job?.id, err }, 'Fluxer delivery job failed');
    });
  }

  async processJob(job: Job<DeliveryJobData>): Promise<void> {
    const { event, bridgePairId, targetChannelId } = job.data;

    log.debug(
      { eventType: event.type, messageId: event.source.messageId, targetChannelId },
      'Processing Fluxer delivery job'
    );

    const allowed = await checkRateLimit('fluxer', targetChannelId);
    if (!allowed) {
      const delay = await getRateLimitDelay('fluxer', targetChannelId);
      await job.moveToDelayed(Date.now() + delay);
      log.warn({ targetChannelId, delay }, 'Rate limited, delaying job');
      return;
    }

    // Get bridge pair to access webhook credentials
    const bridge = await prisma.bridgePair.findUnique({
      where: { id: bridgePairId },
    });

    if (!bridge) {
      log.error({ bridgePairId }, 'Bridge pair not found');
      return;
    }

    const fluxerWebhookId = bridge.fluxerWebhookId;
    const fluxerWebhookToken = bridge.fluxerWebhookToken;

    if (event.type === 'MSG_CREATE') {
      await this.handleMessageCreate(
        event,
        targetChannelId,
        fluxerWebhookId,
        fluxerWebhookToken,
        bridgePairId
      );
    } else if (event.type === 'MSG_UPDATE') {
      await this.handleMessageUpdate(
        event,
        targetChannelId,
        bridge.fluxerGuildId,
        fluxerWebhookId,
        fluxerWebhookToken,
        bridgePairId
      );
    } else if (event.type === 'MSG_DELETE') {
      await this.handleMessageDelete(
        event,
        targetChannelId,
        fluxerWebhookId,
        fluxerWebhookToken,
        bridgePairId
      );
    }
  }

  private async handleMessageCreate(
    event: DeliveryJobData['event'],
    targetChannelId: string,
    fluxerWebhookId: string | null,
    fluxerWebhookToken: string | null,
    bridgePairId: string
  ): Promise<void> {
    if (!event.content?.trim()) {
      log.debug({ messageId: event.source.messageId }, 'Skipping empty message');
      return;
    }

    // Use webhook if available, otherwise fall back to regular message
    if (fluxerWebhookId && fluxerWebhookToken) {
      // Send via webhook and capture the message ID
      const destMsgId = await this.fluxerClient.sendWebhook(
        fluxerWebhookId,
        fluxerWebhookToken,
        event.content,
        event.author.name,
        event.author.avatar,
        targetChannelId // Pass channelId to enable message ID capture
      );

      if (destMsgId) {
        // Create message mapping for edit/delete sync
        await prisma.messageMap.create({
          data: {
            pairId: bridgePairId,
            sourcePlatform: event.source.platform,
            sourceMsgId: event.source.messageId,
            destPlatform: 'fluxer',
            destMsgId,
          },
        });
      }

      // Register the outgoing hash for loop detection
      await registerOutgoingHash(event.content, event.author.name);
      log.info(
        { sourceMsgId: event.source.messageId, destMsgId },
        'Message bridged to Fluxer via webhook'
      );
    } else {
      log.warn(
        { bridgePairId },
        'Missing Fluxer webhook credentials, falling back to regular message'
      );
      const result = await this.fluxerClient.sendMessage(targetChannelId, {
        content: event.content,
        masquerade: {
          name: event.author.name,
          avatar: event.author.avatar || '',
        },
      });

      const destMsgId = result?.id || null;

      if (destMsgId) {
        await prisma.messageMap.create({
          data: {
            pairId: bridgePairId,
            sourcePlatform: event.source.platform,
            sourceMsgId: event.source.messageId,
            destPlatform: 'fluxer',
            destMsgId,
          },
        });

        await registerOutgoingHash(event.content, event.author.name);
        log.info({ sourceMsgId: event.source.messageId, destMsgId }, 'Message bridged to Fluxer');
      }
    }
  }

  private async handleMessageUpdate(
    event: DeliveryJobData['event'],
    targetChannelId: string,
    targetGuildId: string | null,
    fluxerWebhookId: string | null,
    fluxerWebhookToken: string | null,
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

    // Fluxer doesn't support editing webhook messages via API.
    // Workaround: keep original message and post a new "edited content" message with a jump link.
    if (fluxerWebhookId && fluxerWebhookToken) {
      const fluxerMessageUrl = this.buildFluxerMessageUrl(
        targetGuildId,
        targetChannelId,
        messageMap.destMsgId
      );
      const updateContent = this.buildWebhookEditWorkaroundContent(event.content, fluxerMessageUrl);
      const updateTrackerKey = this.getEditUpdateTrackerKey(
        bridgePairId,
        event.source.platform,
        event.source.messageId
      );

      const updateMsgId = await this.fluxerClient.sendWebhook(
        fluxerWebhookId,
        fluxerWebhookToken,
        updateContent,
        event.author.name,
        event.author.avatar,
        targetChannelId
      );

      if (updateMsgId) {
        const redis = getRedisConnection();
        const previousUpdateMsgId = await redis.getset(updateTrackerKey, updateMsgId);
        await redis.expire(updateTrackerKey, EDIT_UPDATE_TTL_SECONDS);

        if (previousUpdateMsgId && previousUpdateMsgId !== updateMsgId) {
          try {
            await this.fluxerClient.deleteMessage(previousUpdateMsgId, targetChannelId);
          } catch (error) {
            log.warn(
              { sourceMsgId: event.source.messageId, previousUpdateMsgId, error },
              'Failed to delete previous Fluxer edit-update message'
            );
          }
        }
      }

      await registerOutgoingHash(updateContent, event.author.name);
      log.info(
        {
          sourceMsgId: event.source.messageId,
          originalDestMsgId: messageMap.destMsgId,
          updateDestMsgId: updateMsgId,
        },
        'Message update mirrored on Fluxer (append+link workaround)'
      );
    } else {
      await this.fluxerClient.editMessage(messageMap.destMsgId, targetChannelId, event.content);
      log.info(
        { sourceMsgId: event.source.messageId, destMsgId: messageMap.destMsgId },
        'Message updated on Fluxer'
      );
    }
  }

  private buildFluxerMessageUrl(
    guildId: string | null,
    channelId: string,
    messageId: string
  ): string {
    const guildSegment = guildId ?? '@me';
    const baseUrl = process.env.FLUXER_WEB_BASE_URL?.replace(/\/+$/, '') || 'https://fluxer.app';
    return `${baseUrl}/channels/${guildSegment}/${channelId}/${messageId}`;
  }

  private buildWebhookEditWorkaroundContent(content: string, fluxerMessageUrl: string): string {
    const body = content?.trimEnd() ?? '';
    const jumpLine = `-# [Jump to original message](${fluxerMessageUrl})`;

    return body ? `${body}\n${jumpLine}` : jumpLine;
  }

  private async handleMessageDelete(
    event: DeliveryJobData['event'],
    targetChannelId: string,
    _fluxerWebhookId: string | null,
    _fluxerWebhookToken: string | null,
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

    const updateTrackerKey = this.getEditUpdateTrackerKey(
      bridgePairId,
      event.source.platform,
      event.source.messageId
    );
    const redis = getRedisConnection();
    const latestUpdateMsgId = await redis.get(updateTrackerKey);
    if (latestUpdateMsgId) {
      try {
        await this.fluxerClient.deleteMessage(latestUpdateMsgId, targetChannelId);
      } catch (error) {
        log.warn(
          { sourceMsgId: event.source.messageId, latestUpdateMsgId, error },
          'Failed to delete latest Fluxer edit-update message during source delete sync'
        );
      }
      await redis.del(updateTrackerKey);
    }

    // Bot can delete any message in the channel with Manage Messages permission
    await this.fluxerClient.deleteMessage(messageMap.destMsgId, targetChannelId);
    await prisma.messageMap.delete({ where: { id: messageMap.id } });
    log.info(
      { sourceMsgId: event.source.messageId, destMsgId: messageMap.destMsgId },
      'Message deleted on Fluxer'
    );
  }

  private getEditUpdateTrackerKey(
    bridgePairId: string,
    sourcePlatform: string,
    sourceMsgId: string
  ): string {
    return `janus:fluxer:edit-update:${bridgePairId}:${sourcePlatform}:${sourceMsgId}`;
  }

  async close(): Promise<void> {
    await this.worker.close();
    log.info('Fluxer delivery worker closed');
  }
}
