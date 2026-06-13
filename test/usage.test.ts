import { describe, it, expect } from "vitest";
import { UsageTracker, type UsageStore } from "../src/core/usage.js";
import type { TokenUsage } from "../src/core/types.js";
import { FakeRedis } from "./helpers/fakeRedis.js";

/** In-memory durable store double. */
class FakeStore implements UsageStore {
  totals = new Map<string, number>();
  prompt = new Map<string, number>();
  completion = new Map<string, number>();
  private k(u: string, p: string) {
    return `${u}|${p}`;
  }
  async getTotal(userId: string, period: string): Promise<number> {
    return this.totals.get(this.k(userId, period)) ?? 0;
  }
  async add(userId: string, period: string, usage: TokenUsage): Promise<void> {
    const k = this.k(userId, period);
    const total = usage.totalTokens || usage.promptTokens + usage.completionTokens;
    this.totals.set(k, (this.totals.get(k) ?? 0) + total);
    this.prompt.set(k, (this.prompt.get(k) ?? 0) + usage.promptTokens);
    this.completion.set(k, (this.completion.get(k) ?? 0) + usage.completionTokens);
  }
}

const FIXED = () => new Date("2026-06-14T12:00:00Z");

describe("UsageTracker", () => {
  it("computes a daily period bucket", () => {
    const t = new UsageTracker(new FakeRedis(), new FakeStore(), 1000, "day", FIXED);
    expect(t.currentPeriod()).toBe("2026-06-14");
  });

  it("computes a monthly period bucket", () => {
    const t = new UsageTracker(new FakeRedis(), new FakeStore(), 1000, "month", FIXED);
    expect(t.currentPeriod()).toBe("2026-06-01");
  });

  it("starts within budget and accumulates usage", async () => {
    const store = new FakeStore();
    const t = new UsageTracker(new FakeRedis(), store, 100, "day", FIXED);

    expect(await t.withinBudget("u1")).toBe(true);
    await t.add("u1", { promptTokens: 30, completionTokens: 20, totalTokens: 50 });
    expect(await t.getTotal("u1")).toBe(50);
    expect(await store.getTotal("u1", "2026-06-14")).toBe(50);
    expect(await t.withinBudget("u1")).toBe(true);
  });

  it("blocks once the budget is exceeded", async () => {
    const t = new UsageTracker(new FakeRedis(), new FakeStore(), 100, "day", FIXED);
    await t.add("u1", { promptTokens: 60, completionTokens: 60, totalTokens: 120 });
    expect(await t.withinBudget("u1")).toBe(false);
  });

  it("warms the Redis counter from the store on a miss", async () => {
    const redis = new FakeRedis();
    const store = new FakeStore();
    await store.add("u1", "2026-06-14", { promptTokens: 40, completionTokens: 40, totalTokens: 80 });
    const t = new UsageTracker(redis, store, 100, "day", FIXED);

    // First read warms from store.
    expect(await t.getTotal("u1")).toBe(80);
    // Counter now lives in Redis.
    expect(await redis.get("usage:u1:2026-06-14")).toBe("80");
  });

  it("ignores zero-token usage", async () => {
    const store = new FakeStore();
    const t = new UsageTracker(new FakeRedis(), store, 100, "day", FIXED);
    await t.add("u1", { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
    expect(await t.getTotal("u1")).toBe(0);
  });
});
