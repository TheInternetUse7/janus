import dotenv from 'dotenv';
dotenv.config();

function required(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optional(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

export const config = {
  // Discord
  discord: {
    token: required('DISCORD_TOKEN'),
    shardCount: parseInt(optional('DISCORD_SHARD_COUNT', 'auto'), 10) || ('auto' as const),
  },

  // Fluxer
  fluxer: {
    token: required('FLUXER_TOKEN'),
    apiBaseUrl: optional('FLUXER_API_URL', 'https://api.fluxer.app'),
    wsUrl: optional('FLUXER_WS_URL', 'wss://gateway.fluxer.app'),
  },

  // Database
  database: {
    url: required('DATABASE_URL'),
  },

  // Redis
  redis: {
    url: optional('REDIS_URL', 'redis://localhost:6379'),
  },

  // Rate Limits
  rateLimits: {
    globalPerSecond: parseInt(optional('RATE_LIMIT_GLOBAL', '50'), 10),
    perChannelPer2s: parseInt(optional('RATE_LIMIT_PER_CHANNEL', '5'), 10),
  },

  // Circuit Breaker
  circuitBreaker: {
    failureThreshold: parseInt(optional('CB_FAILURE_THRESHOLD', '10'), 10),
    resetTimeout: parseInt(optional('CB_RESET_TIMEOUT', '60000'), 10), // 60s
  },

  // Loop Detection
  loopFilter: {
    hashTtlSeconds: parseInt(optional('LOOP_HASH_TTL', '10'), 10),
  },

  // Logging
  logLevel: optional('LOG_LEVEL', 'info'),
} as const;
