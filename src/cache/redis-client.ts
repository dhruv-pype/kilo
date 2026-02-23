import Redis from 'ioredis';
import { CacheError } from '../common/errors/index.js';

let redis: Redis | null = null;

export function getRedis(): Redis {
  if (!redis) {
    throw new CacheError('Redis not initialized. Call initRedis() first.');
  }
  return redis;
}

export function initRedis(redisUrl: string): Redis {
  if (redis) {
    return redis;
  }

  redis = new Redis(redisUrl, {
    maxRetriesPerRequest: 3,
    lazyConnect: true,
    connectTimeout: 5_000,
    retryStrategy(times) {
      // Exponential backoff: 100ms, 200ms, 400ms... max 3s
      return Math.min(times * 100, 3_000);
    },
  });

  redis.on('error', (err) => {
    console.error('Redis connection error:', err.message);
  });

  return redis;
}

export async function closeRedis(): Promise<void> {
  if (redis) {
    await redis.quit();
    redis = null;
  }
}
