import { Queue } from 'bullmq';
import { createChildLogger } from './logger';
import type { IngestJobData, DeliveryJobData } from '../types/canonical';

const log = createChildLogger('queues');

function getRedisOptions() {
  const url = process.env.REDIS_URL || 'redis://localhost:6379';
  return { connection: { url } };
}

/**
 * The high-speed FIFO ingest queue.
 * All normalized CanonicalEvents land here first.
 */
export const ingestQueue = new Queue<IngestJobData>('janus:ingest', {
  ...getRedisOptions(),
  defaultJobOptions: {
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
  },
});

/**
 * Delivery queue factory - creates per-platform:channel queues
 * Uses the Demultiplexing Pattern to prevent "Noisy Neighbor" problems.
 */
const deliveryQueues = new Map<string, Queue<DeliveryJobData>>();

export function getDeliveryQueue(platform: string, channelId: string): Queue<DeliveryJobData> {
  const queueName = `janus:deliver:${platform}:${channelId}`;

  if (!deliveryQueues.has(queueName)) {
    log.debug({ queueName }, 'Creating new delivery queue');
    const queue = new Queue<DeliveryJobData>(queueName, {
      ...getRedisOptions(),
      defaultJobOptions: {
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 2000 },
        attempts: 5,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
      },
    });
    deliveryQueues.set(queueName, queue);
  }

  return deliveryQueues.get(queueName)!;
}

/**
 * Get all active delivery queue names (for worker registration)
 */
export function getActiveDeliveryQueueNames(): string[] {
  return Array.from(deliveryQueues.keys());
}

export async function closeAllQueues(): Promise<void> {
  log.info('Closing all queues...');
  await ingestQueue.close();
  for (const [name, queue] of deliveryQueues) {
    await queue.close();
    log.debug({ queueName: name }, 'Delivery queue closed');
  }
  deliveryQueues.clear();
  log.info('All queues closed');
}
