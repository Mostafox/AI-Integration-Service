import { randomUUID } from "node:crypto";
import type { RedisLike } from "./redisTypes.js";

/**
 * Per-chat mutual exclusion via Redis `SET key token NX PX ttl`.
 *
 * Serializes concurrent POST /v1/messages for the same chat so turns can't
 * interleave and summarization can't double-run. A second concurrent message
 * for the same chat fails to acquire and is rejected with `chat_busy`.
 *
 * Release is token-guarded (Lua compare-and-delete) so a slow request whose
 * lock already expired cannot delete a lock a later request now holds.
 */

const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end`;

export interface ChatLockHandle {
  release(): Promise<void>;
}

export class ChatLock {
  constructor(
    private readonly redis: RedisLike,
    private readonly ttlMs: number
  ) {}

  private key(chatId: string): string {
    return `chat:${chatId}:lock`;
  }

  /**
   * Try to acquire the lock. Returns a handle on success, or null if the chat
   * is already locked (caller should respond `chat_busy`).
   */
  async acquire(chatId: string): Promise<ChatLockHandle | null> {
    const token = randomUUID();
    const key = this.key(chatId);
    const res = await this.redis.set(key, token, "PX", this.ttlMs, "NX");
    if (res !== "OK") return null;

    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        await this.redis.eval(RELEASE_SCRIPT, 1, key, token);
      },
    };
  }
}
