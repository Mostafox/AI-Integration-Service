/**
 * Structural subset of ioredis we depend on. Keeping it narrow means the cache,
 * lock, and usage modules can be unit-tested with a tiny in-memory fake, and the
 * store can later move to a different backend without touching callers.
 */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    ...args: (string | number)[]
  ): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  incrby(key: string, increment: number): Promise<number>;
  ttl(key: string): Promise<number>;
  eval(
    script: string,
    numkeys: number,
    ...args: (string | number)[]
  ): Promise<unknown>;
}
