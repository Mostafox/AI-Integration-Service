import { describe, it, expect } from "vitest";
import { ChatCache } from "../src/core/chatCache.js";
import type { ChatContext } from "../src/core/types.js";
import { FakeRedis } from "./helpers/fakeRedis.js";

function ctx(chatId = "c1"): ChatContext {
  return {
    chatId,
    userId: "u1",
    model: "m",
    systemPrompt: "be terse",
    summary: null,
    recent: [{ role: "user", content: "hi" }],
  };
}

describe("ChatCache", () => {
  it("round-trips a context on hit and returns null on miss", async () => {
    const cache = new ChatCache(new FakeRedis(), 300);
    expect(await cache.getContext("c1")).toBeNull();
    await cache.setContext(ctx());
    expect(await cache.getContext("c1")).toEqual(ctx());
  });

  it("sets a 5-minute TTL on the context", async () => {
    const redis = new FakeRedis();
    const cache = new ChatCache(redis, 300);
    await cache.setContext(ctx());
    const ttl = await cache.ttl("c1");
    expect(ttl).toBeGreaterThan(295);
    expect(ttl).toBeLessThanOrEqual(300);
  });

  it("expires the context after the TTL elapses", async () => {
    let t = 0;
    const redis = new FakeRedis(() => t);
    const cache = new ChatCache(redis, 300);
    await cache.setContext(ctx());
    t = 301_000;
    expect(await cache.getContext("c1")).toBeNull();
  });

  it("invalidate removes the cached context", async () => {
    const cache = new ChatCache(new FakeRedis(), 300);
    await cache.setContext(ctx());
    await cache.invalidate("c1");
    expect(await cache.getContext("c1")).toBeNull();
  });

  it("stores and reads the active-chat pointer", async () => {
    const cache = new ChatCache(new FakeRedis(), 300);
    expect(await cache.getActiveChatId("u1")).toBeNull();
    await cache.setActiveChatId("u1", "c9");
    expect(await cache.getActiveChatId("u1")).toBe("c9");
  });
});
