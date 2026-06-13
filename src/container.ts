import { config } from "./config.js";
import { db } from "./db/index.js";
import { redis as ioredis } from "./redis.js";
import type { RedisLike } from "./core/redisTypes.js";
import { ChatCache } from "./core/chatCache.js";
import { ChatLock } from "./core/chatLock.js";
import { ChatRepo } from "./core/chatRepo.js";
import { ChatService } from "./core/chatService.js";
import { KeyPool } from "./core/keyPool.js";
import { OpenRouterClient } from "./core/openrouter.js";
import { Summarizer } from "./core/summarizer.js";
import { DrizzleUsageStore, UsageTracker } from "./core/usage.js";

/**
 * Composition root: builds the core library from config + db + redis and wires
 * the ChatService. The single KeyPool instance lives here so its in-memory
 * counters stay authoritative for the (single) process.
 */

// ioredis satisfies RedisLike at runtime; its callback overloads on set/eval
// don't structurally match the narrow interface, so adapt the type here.
const redis = ioredis as unknown as RedisLike;

export const keyPool = new KeyPool(config.openrouter.keys);

const repo = new ChatRepo(db);
const cache = new ChatCache(redis, config.cache.ttlSeconds);
const lock = new ChatLock(redis, config.cache.chatLockTtlMs);
const openrouter = new OpenRouterClient({ baseUrl: config.openrouter.baseUrl });
const usage = new UsageTracker(
  redis,
  new DrizzleUsageStore(db),
  config.limits.userTokenBudget,
  config.limits.budgetPeriod
);
const summarizer = new Summarizer(repo, openrouter, keyPool, {
  summarizeAfterMessages: config.limits.summarizeAfterMessages,
  keepRecentMessages: config.limits.keepRecentMessages,
  model: config.openrouter.summaryModel,
});

export const chatService = new ChatService({
  repo,
  cache,
  lock,
  keyPool,
  openrouter,
  summarizer,
  usage,
  defaultModel: config.openrouter.defaultModel,
});

export { repo as chatRepo, cache as chatCache };
