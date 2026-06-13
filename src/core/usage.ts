import { sql } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { userUsage } from "../db/schema.js";
import type { RedisLike } from "./redisTypes.js";
import type { TokenUsage } from "./types.js";

/**
 * Per-user token accounting + budget cap.
 *
 * Hot path reads a Redis counter (usage:{userId}:{period}); writes go through to
 * both Redis (fast subsequent checks) and a durable store (the `user_usage`
 * table, source of truth). On a Redis miss the counter is warmed from the store.
 */

export type BudgetPeriod = "day" | "month";

/** Durable accumulation backend. Drizzle-backed in prod; fakeable in tests. */
export interface UsageStore {
  getTotal(userId: string, period: string): Promise<number>;
  add(userId: string, period: string, usage: TokenUsage): Promise<void>;
}

/** Drizzle/Postgres implementation of UsageStore over the user_usage table. */
export class DrizzleUsageStore implements UsageStore {
  constructor(private readonly db: Database) {}

  async getTotal(userId: string, period: string): Promise<number> {
    const [row] = await this.db
      .select({ total: userUsage.totalTokens })
      .from(userUsage)
      .where(sql`${userUsage.userId} = ${userId} AND ${userUsage.period} = ${period}`)
      .limit(1);
    return row?.total ?? 0;
  }

  async add(userId: string, period: string, usage: TokenUsage): Promise<void> {
    const total = usage.totalTokens || usage.promptTokens + usage.completionTokens;
    await this.db
      .insert(userUsage)
      .values({
        userId,
        period,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: total,
      })
      .onConflictDoUpdate({
        target: [userUsage.userId, userUsage.period],
        set: {
          promptTokens: sql`${userUsage.promptTokens} + ${usage.promptTokens}`,
          completionTokens: sql`${userUsage.completionTokens} + ${usage.completionTokens}`,
          totalTokens: sql`${userUsage.totalTokens} + ${total}`,
          updatedAt: new Date(),
        },
      });
  }
}

export class UsageTracker {
  constructor(
    private readonly redis: RedisLike,
    private readonly store: UsageStore,
    private readonly budget: number,
    private readonly period: BudgetPeriod,
    private readonly now: () => Date = () => new Date()
  ) {}

  /** Period bucket as a YYYY-MM-DD date (first-of-month for "month"). */
  currentPeriod(): string {
    const d = this.now();
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    if (this.period === "month") return `${y}-${m}-01`;
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  private counterKey(userId: string, period: string): string {
    return `usage:${userId}:${period}`;
  }

  private counterTtl(): number {
    return this.period === "month" ? 2_678_400 : 90_000;
  }

  /** Total tokens used this period (Redis-first, store fallback + warm). */
  async getTotal(userId: string): Promise<number> {
    const period = this.currentPeriod();
    const key = this.counterKey(userId, period);
    const cached = await this.redis.get(key);
    if (cached !== null) return Number(cached);

    const total = await this.store.getTotal(userId, period);
    await this.redis.set(key, String(total), "EX", this.counterTtl());
    return total;
  }

  async withinBudget(userId: string): Promise<boolean> {
    const total = await this.getTotal(userId);
    return total < this.budget;
  }

  /**
   * Record token usage from a completed (or interrupted) stream.
   * Increments the Redis counter and the durable store.
   */
  async add(userId: string, usage: TokenUsage): Promise<void> {
    const period = this.currentPeriod();
    const total = usage.totalTokens || usage.promptTokens + usage.completionTokens;
    if (total <= 0) return;

    const key = this.counterKey(userId, period);
    // Ensure the counter is warmed from the store before incrementing, so the
    // fast-path total stays consistent even on the first write of a period.
    await this.getTotal(userId);
    await this.redis.incrby(key, total);
    await this.redis.expire(key, this.counterTtl());

    await this.store.add(userId, period, usage);
  }
}
