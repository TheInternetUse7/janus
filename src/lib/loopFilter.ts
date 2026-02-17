import { createHash } from 'crypto';
import { getRedisConnection } from './redis';
import { createChildLogger } from './logger';

const log = createChildLogger('loop-filter');

const HASH_TTL_SECONDS = parseInt(process.env.LOOP_HASH_TTL || '10', 10);

/**
 * The Janus Filter - SHA-256 based loop detection.
 *
 * Prevents Bot A triggering Bot B triggering Bot A (The Infinite Echo).
 *
 * Before sending a message, we compute a content hash and store it in Redis.
 * On ingest, if an incoming message matches a stored hash, we DROP it.
 */

/**
 * Generate a SHA-256 fingerprint for a message.
 * Hash = SHA256(content + author_name + timestamp_minute)
 */
export function generateContentHash(content: string, authorName: string): string {
  const timestampMinute = Math.floor(Date.now() / 60000).toString();
  const payload = `${content}|${authorName}|${timestampMinute}`;
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * Register a hash before sending (mark as "ours").
 * SET janus:hash:{hash} 1 EX 10
 */
export async function registerOutgoingHash(content: string, authorName: string): Promise<void> {
  const hash = generateContentHash(content, authorName);
  const redis = getRedisConnection();
  const key = `janus:hash:${hash}`;
  await redis.set(key, '1', 'EX', HASH_TTL_SECONDS);
  log.debug({ hash: hash.substring(0, 12) }, 'Registered outgoing hash');
}

/**
 * Check if an incoming message is an echo of something we sent.
 * Returns true if the message should be DROPPED (it's a loop).
 */
export async function isLoopMessage(content: string, authorName: string): Promise<boolean> {
  const hash = generateContentHash(content, authorName);
  const redis = getRedisConnection();
  const key = `janus:hash:${hash}`;
  const exists = await redis.exists(key);

  if (exists) {
    log.warn({ hash: hash.substring(0, 12) }, 'Loop detected! Dropping message.');
    return true;
  }

  return false;
}
