import { Worker, Job } from 'bullmq';
import { createChildLogger } from '../lib/logger';
import { prisma } from '../lib/database';
import { getDeliveryQueue, ingestQueue } from '../lib/queues';
import { isLoopMessage } from '../lib/loopFilter';
import type { IngestJobData, DeliveryJobData } from '../types/canonical';

const log = createChildLogger('router-worker');

export class RouterWorker {
  private worker: Worker<IngestJobData>;

  constructor() {
    this.worker = new Worker<IngestJobData>(
      'janus:ingest',
      async (job: Job<IngestJobData>) => {
        return this.processJob(job);
      },
      {
        connection: { url: process.env.REDIS_URL || 'redis://localhost:6379' },
        concurrency: 10,
      }
    );

    this.worker.on('completed', (job) => {
      log.debug({ jobId: job.id }, 'Router job completed');
    });

    this.worker.on('failed', (job, err) => {
      log.error({ jobId: job?.id, err }, 'Router job failed');
    });
  }

  async processJob(job: Job<IngestJobData>): Promise<void> {
    const { event } = job.data;
    log.debug(
      { eventType: event.type, platform: event.source.platform, channelId: event.source.channelId },
      'Processing ingest job'
    );

    const isLoop = await isLoopMessage(event.content, event.author.name);
    if (isLoop) {
      log.info({ messageId: event.source.messageId }, 'Dropping loop message');
      return;
    }

    const bridgePairs = await this.findBridgePairs(event.source.platform, event.source.channelId);
    
    if (bridgePairs.length === 0) {
      log.debug({ channelId: event.source.channelId }, 'No bridge pairs found for channel');
      return;
    }

    for (const pair of bridgePairs) {
      if (!pair.isActive) continue;

      const targetPlatform = event.source.platform === 'discord' ? 'fluxer' : 'discord';
      const targetChannelId = event.source.platform === 'discord' ? pair.fluxerChannelId : pair.discordChannelId;
      const targetGuildId = event.source.platform === 'discord' ? pair.fluxerGuildId : pair.discordGuildId;

      const jobData: DeliveryJobData = {
        event,
        bridgePairId: pair.id,
        targetPlatform,
        targetChannelId,
        targetGuildId,
        discordWebhookId: pair.discordWebhookId ?? undefined,
        discordWebhookToken: pair.discordWebhookToken ?? undefined,
        syncUploads: pair.syncUploads,
      };

      const deliveryQueue = getDeliveryQueue(targetPlatform, targetChannelId);
      await deliveryQueue.add('deliver', jobData);

      log.debug(
        { bridgePairId: pair.id, targetPlatform, targetChannelId },
        'Dispatched to delivery queue'
      );
    }
  }

  private async findBridgePairs(sourcePlatform: string, sourceChannelId: string) {
    if (sourcePlatform === 'discord') {
      return prisma.bridgePair.findMany({
        where: {
          discordChannelId: sourceChannelId,
          isActive: true,
        },
      });
    } else {
      return prisma.bridgePair.findMany({
        where: {
          fluxerChannelId: sourceChannelId,
          isActive: true,
        },
      });
    }
  }

  async close(): Promise<void> {
    await this.worker.close();
    log.info('Router worker closed');
  }
}
