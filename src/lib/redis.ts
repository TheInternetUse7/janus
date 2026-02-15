import IORedis from 'ioredis';
import { createChildLogger } from './logger';

const log = createChildLogger('redis');

let redisConnection: IORedis | null = null;

export function getRedisConnection(): IORedis {
  if (!redisConnection) {
    const url = process.env.REDIS_URL || 'redis://localhost:6379';
    redisConnection = new IORedis(url, {
      maxRetriesPerRequest: null, // Required by BullMQ
      enableReadyCheck: false,
    });

    redisConnection.on('connect', () => {
      log.info('Redis connected');
    });

    redisConnection.on('error', (err) => {
      log.error({ err }, 'Redis connection error');
    });
  }
  return redisConnection;
}

/**
 * Create a new IORedis instance for BullMQ (each worker/queue needs its own)
 */
export function createRedisConnection(): IORedis {
  const url = process.env.REDIS_URL || 'redis://localhost:6379';
  return new IORedis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}

export async function disconnectRedis(): Promise<void> {
  if (redisConnection) {
    await redisConnection.quit();
    redisConnection = null;
    log.info('Redis disconnected');
  }
}
