import { describe, it, expect } from "vitest";
import { ChatLock } from "../src/core/chatLock.js";
import { FakeRedis } from "./helpers/fakeRedis.js";

describe("ChatLock", () => {
  it("grants the lock once and rejects a concurrent acquire (NX)", async () => {
    const lock = new ChatLock(new FakeRedis(), 5000);
    const a = await lock.acquire("c1");
    const b = await lock.acquire("c1");
    expect(a).not.toBeNull();
    expect(b).toBeNull();
  });

  it("allows re-acquire after release", async () => {
    const lock = new ChatLock(new FakeRedis(), 5000);
    const a = await lock.acquire("c1");
    await a!.release();
    const b = await lock.acquire("c1");
    expect(b).not.toBeNull();
  });

  it("locks are per-chat (different chats don't contend)", async () => {
    const lock = new ChatLock(new FakeRedis(), 5000);
    const a = await lock.acquire("c1");
    const b = await lock.acquire("c2");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
  });

  it("auto-expires after the lock TTL", async () => {
    let t = 0;
    const lock = new ChatLock(new FakeRedis(() => t), 1000);
    const a = await lock.acquire("c1");
    expect(a).not.toBeNull();
    t = 1001;
    const b = await lock.acquire("c1");
    expect(b).not.toBeNull();
  });

  it("release is token-guarded: a stale holder cannot free a re-acquired lock", async () => {
    let t = 0;
    const redis = new FakeRedis(() => t);
    const lock = new ChatLock(redis, 1000);

    const a = await lock.acquire("c1"); // holds token A
    t = 1001; // A's lock expires
    const b = await lock.acquire("c1"); // B acquires fresh token
    expect(b).not.toBeNull();

    // A releasing must NOT delete B's lock.
    await a!.release();
    const c = await lock.acquire("c1");
    expect(c).toBeNull();
  });
});
