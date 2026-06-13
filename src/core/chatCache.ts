import type { RedisLike } from "./redisTypes.js";
import type { ChatContext } from "./types.js";

/**
 * Redis caching for the hot read path. Two kinds of keys:
 *
 *  - Active-chat pointer:  user:{userId}:active_chat -> chatId
 *      Resolves a returning user's chat without a Postgres lookup.
 *  - History payload:      chat:{chatId} -> JSON(ChatContext)
 *      The exact bounded shape we feed to OpenRouter.
 *
 * TTL is 5 minutes (configurable). Postgres remains the source of truth — every
 * cached value is reconstructable, so a miss/eviction is always safe.
 */
export class ChatCache {
  constructor(
    private readonly redis: RedisLike,
    private readonly ttlSeconds: number
  ) {}

  private chatKey(chatId: string): string {
    return `chat:${chatId}`;
  }

  private activeKey(userId: string): string {
    return `user:${userId}:active_chat`;
  }

  // --- active-chat pointer ---

  async getActiveChatId(userId: string): Promise<string | null> {
    return this.redis.get(this.activeKey(userId));
  }

  async setActiveChatId(userId: string, chatId: string): Promise<void> {
    // Pointer outlives a single history window; give it the same TTL but it is
    // refreshed on every send and repopulated from Postgres on miss.
    await this.redis.set(this.activeKey(userId), chatId, "EX", this.ttlSeconds);
  }

  // --- history payload ---

  async getContext(chatId: string): Promise<ChatContext | null> {
    const raw = await this.redis.get(this.chatKey(chatId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ChatContext;
    } catch {
      return null;
    }
  }

  /** Write-through + TTL refresh. */
  async setContext(ctx: ChatContext): Promise<void> {
    await this.redis.set(
      this.chatKey(ctx.chatId),
      JSON.stringify(ctx),
      "EX",
      this.ttlSeconds
    );
  }

  async invalidate(chatId: string): Promise<void> {
    await this.redis.del(this.chatKey(chatId));
  }

  /** Remaining TTL in seconds for a chat's cached history (-2 = missing). */
  async ttl(chatId: string): Promise<number> {
    return this.redis.ttl(this.chatKey(chatId));
  }
}
