import { Worker, Job } from 'bullmq';
import { createChildLogger } from '../lib/logger';
import { prisma } from '../lib/database';
import { checkRateLimit, getRateLimitDelay } from '../lib/rateLimiter';
import { registerOutgoingHash } from '../lib/loopFilter';
import { FluxerClient } from '../platforms/fluxer/client';
import type { DeliveryJobData } from '../types/canonical';

const log = createChildLogger('fluxer-delivery-worker');

export class FluxerDeliveryWorker {
  private worker: Worker<DeliveryJobData>;
  private fluxerClient: FluxerClient;

  constructor(fluxerClient: FluxerClient) {
    this.fluxerClient = fluxerClient;

    this.worker = new Worker<DeliveryJobData>(
      'janus_deliver_fluxer_*',
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

    if (event.type === 'MSG_CREATE') {
      await this.handleMessageCreate(event, targetChannelId, bridgePairId);
    } else if (event.type === 'MSG_UPDATE') {
      await this.handleMessageUpdate(event, targetChannelId, bridgePairId);
    } else if (event.type === 'MSG_DELETE') {
      await this.handleMessageDelete(event, targetChannelId, bridgePairId);
    }
  }

  private async handleMessageCreate(
    event: DeliveryJobData['event'],
    targetChannelId: string,
    bridgePairId: string
  ): Promise<void> {
    const result = await this.fluxerClient.sendMessage(targetChannelId, {
      content: event.content,
      masquerade: {
        name: event.author.name,
        avatar: event.author.avatar || '',
      },
    });

    if (result?.id) {
      await prisma.messageMap.create({
        data: {
          pairId: bridgePairId,
          sourcePlatform: event.source.platform,
          sourceMsgId: event.source.messageId,
          destPlatform: 'fluxer',
          destMsgId: result.id,
        },
      });

      await registerOutgoingHash(event.content, event.author.name);
      log.info({ sourceMsgId: event.source.messageId, destMsgId: result.id }, 'Message bridged to Fluxer');
    }
  }

  private async handleMessageUpdate(
    event: DeliveryJobData['event'],
    targetChannelId: string,
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

    await this.fluxerClient.editMessage(messageMap.destMsgId, targetChannelId, event.content);
    log.info({ sourceMsgId: event.source.messageId, destMsgId: messageMap.destMsgId }, 'Message updated on Fluxer');
  }

  private async handleMessageDelete(
    event: DeliveryJobData['event'],
    targetChannelId: string,
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

    await this.fluxerClient.deleteMessage(messageMap.destMsgId, targetChannelId);
    await prisma.messageMap.delete({ where: { id: messageMap.id } });
    log.info({ sourceMsgId: event.source.messageId, destMsgId: messageMap.destMsgId }, 'Message deleted on Fluxer');
  }

  async close(): Promise<void> {
    await this.worker.close();
    log.info('Fluxer delivery worker closed');
  }
}
