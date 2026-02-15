import { getRedisConnection } from './redis';
import { createChildLogger } from './logger';

const log = createChildLogger('rate-limiter');

const PER_CHANNEL_LIMIT = parseInt(process.env.RATE_LIMIT_PER_CHANNEL || '5', 10);
const WINDOW_SECONDS = 2;

/**
 * Leaky Bucket Rate Limiter using Redis.
 * 
 * Per-Channel Limit: 5 req/2s (Standard Discord Webhook limit).
 * Returns true if the request is allowed, false if rate limited.
 */
export async function checkRateLimit(platform: string, channelId: string): Promise<boolean> {
  const redis = getRedisConnection();
  const limitKey = `janus:ratelimit:${platform}:${channelId}`;

  const currentUsage = await redis.incr(limitKey);

  // Set expiry on first increment
  if (currentUsage === 1) {
    await redis.expire(limitKey, WINDOW_SECONDS);
  }

  if (currentUsage > PER_CHANNEL_LIMIT) {
    log.warn(
      { platform, channelId, currentUsage, limit: PER_CHANNEL_LIMIT },
      'Rate limit exceeded for channel'
    );
    return false;
  }

  return true;
}

/**
 * Get the delay in ms before the rate limit window resets for a channel.
 */
export async function getRateLimitDelay(platform: string, channelId: string): Promise<number> {
  const redis = getRedisConnection();
  const limitKey = `janus:ratelimit:${platform}:${channelId}`;
  const ttl = await redis.pttl(limitKey);
  return ttl > 0 ? ttl : WINDOW_SECONDS * 1000;
}
