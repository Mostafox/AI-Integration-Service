/**
 * OpenRouter API key rotation.
 *
 * Strategy: least-in-flight selection among non-cooled keys (round-robin
 * tiebreak). This load-balances variable-length streams better than plain
 * round-robin. On 429/quota a key is put on cooldown (honoring Retry-After);
 * callers transparently retry on the next key only if no tokens were sent yet.
 *
 * v1 keeps counters in-memory (single process). The interface is deliberately
 * small so the store can move to Redis for multi-instance later.
 */

export interface KeyStatus {
  /** Masked key (last 4 chars) for logs/health — never expose the full key. */
  masked: string;
  inFlight: number;
  cooldownUntil: number | null;
  cooling: boolean;
}

interface KeyState {
  key: string;
  inFlight: number;
  /** epoch ms until which the key is cooling; 0 = available. */
  cooldownUntil: number;
  /** monotonically increasing last-selected order, for round-robin tiebreak. */
  lastSelectedSeq: number;
}

/** Handle returned by acquire(); release() must be called exactly once. */
export interface KeyLease {
  key: string;
  release(): void;
}

export class AllKeysBusyError extends Error {
  /** Soonest epoch ms a key becomes available, for Retry-After. */
  readonly retryAtMs: number;
  constructor(retryAtMs: number) {
    super("all_keys_cooling");
    this.name = "AllKeysBusyError";
    this.retryAtMs = retryAtMs;
  }
}

export class KeyPool {
  private states: KeyState[];
  private seq = 0;
  private readonly now: () => number;

  constructor(keys: string[], now: () => number = Date.now) {
    if (keys.length === 0) throw new Error("KeyPool requires at least one key");
    // Dedupe while preserving order.
    const unique = [...new Set(keys)];
    this.states = unique.map((key) => ({
      key,
      inFlight: 0,
      cooldownUntil: 0,
      lastSelectedSeq: 0,
    }));
    this.now = now;
  }

  /**
   * Reserve the best available key (increments its in-flight count).
   * Throws AllKeysBusyError when every key is cooling.
   */
  acquire(): KeyLease {
    const t = this.now();
    const available = this.states.filter((s) => s.cooldownUntil <= t);

    if (available.length === 0) {
      const soonest = Math.min(...this.states.map((s) => s.cooldownUntil));
      throw new AllKeysBusyError(soonest);
    }

    // Least in-flight, then least-recently-selected (round-robin tiebreak).
    available.sort((a, b) => {
      if (a.inFlight !== b.inFlight) return a.inFlight - b.inFlight;
      return a.lastSelectedSeq - b.lastSelectedSeq;
    });

    const chosen = available[0];
    chosen.inFlight += 1;
    chosen.lastSelectedSeq = ++this.seq;

    let released = false;
    return {
      key: chosen.key,
      release: () => {
        if (released) return;
        released = true;
        chosen.inFlight = Math.max(0, chosen.inFlight - 1);
      },
    };
  }

  /**
   * Put a key on cooldown after a 429/quota error.
   * @param key the offending key
   * @param retryAfterMs how long to bench it (defaults to 30s)
   */
  cooldown(key: string, retryAfterMs = 30_000): void {
    const s = this.states.find((x) => x.key === key);
    if (!s) return;
    s.cooldownUntil = this.now() + Math.max(0, retryAfterMs);
  }

  /** Number of keys not currently cooling. */
  availableCount(): number {
    const t = this.now();
    return this.states.filter((s) => s.cooldownUntil <= t).length;
  }

  /** Snapshot for /health (keys masked). */
  status(): KeyStatus[] {
    const t = this.now();
    return this.states.map((s) => ({
      masked: `...${s.key.slice(-4)}`,
      inFlight: s.inFlight,
      cooldownUntil: s.cooldownUntil > t ? s.cooldownUntil : null,
      cooling: s.cooldownUntil > t,
    }));
  }
}
