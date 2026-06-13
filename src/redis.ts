import Redis from "ioredis";
import { config } from "./config.js";

/**
 * Shared ioredis connection for the process.
 */
export const redis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
});

export async function closeRedis(): Promise<void> {
  await redis.quit();
}
