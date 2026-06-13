import type { RedisLike } from "../../src/core/redisTypes.js";

/**
 * Tiny in-memory Redis double covering exactly the commands our modules use:
 * GET/SET (with EX/PX/NX), DEL, EXPIRE, INCRBY, TTL, and the lock-release EVAL.
 * Supports an injectable clock so TTL/expiry can be tested deterministically.
 */
interface Entry {
  value: string;
  expireAt: number | null; // epoch ms
}

export class FakeRedis implements RedisLike {
  private store = new Map<string, Entry>();
  constructor(private now: () => number = () => Date.now()) {}

  setClock(now: () => number) {
    this.now = now;
  }

  private live(key: string): Entry | undefined {
    const e = this.store.get(key);
    if (!e) return undefined;
    if (e.expireAt !== null && e.expireAt <= this.now()) {
      this.store.delete(key);
      return undefined;
    }
    return e;
  }

  async get(key: string): Promise<string | null> {
    return this.live(key)?.value ?? null;
  }

  async set(key: string, value: string, ...args: (string | number)[]): Promise<string | null> {
    const flags = args.map((a) => String(a).toUpperCase());
    const nx = flags.includes("NX");
    if (nx && this.live(key)) return null;

    let expireAt: number | null = null;
    for (let i = 0; i < args.length - 1; i++) {
      const flag = String(args[i]).toUpperCase();
      if (flag === "EX") expireAt = this.now() + Number(args[i + 1]) * 1000;
      if (flag === "PX") expireAt = this.now() + Number(args[i + 1]);
    }
    this.store.set(key, { value, expireAt });
    return "OK";
  }

  async del(...keys: string[]): Promise<number> {
    let n = 0;
    for (const k of keys) if (this.store.delete(k)) n++;
    return n;
  }

  async expire(key: string, seconds: number): Promise<number> {
    const e = this.live(key);
    if (!e) return 0;
    e.expireAt = this.now() + seconds * 1000;
    return 1;
  }

  async incrby(key: string, increment: number): Promise<number> {
    const e = this.live(key);
    const next = (e ? Number(e.value) : 0) + increment;
    this.store.set(key, { value: String(next), expireAt: e?.expireAt ?? null });
    return next;
  }

  async ttl(key: string): Promise<number> {
    const e = this.live(key);
    if (!e) return -2;
    if (e.expireAt === null) return -1;
    return Math.ceil((e.expireAt - this.now()) / 1000);
  }

  async eval(_script: string, _numkeys: number, ...args: (string | number)[]): Promise<unknown> {
    // Only the compare-and-delete release script is used.
    const key = String(args[0]);
    const token = String(args[1]);
    const e = this.live(key);
    if (e && e.value === token) {
      this.store.delete(key);
      return 1;
    }
    return 0;
  }
}
