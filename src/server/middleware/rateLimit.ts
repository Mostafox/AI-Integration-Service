import type { MiddlewareHandler } from "hono";
import { config } from "../../config.js";
import type { AppVariables } from "./auth.js";

/**
 * In-memory per-user fixed-window rate limiter (requests/minute). Protects the
 * OpenRouter key pool from a single noisy client. Authoritative because v1 runs
 * a single process; moves to Redis (INCR + TTL) when multi-instance.
 *
 * Must run AFTER auth (reads c.var.user).
 */

interface Window {
  count: number;
  resetAt: number; // epoch ms
}

const WINDOW_MS = 60_000;

export function createRateLimiter(
  rpm = config.limits.rateLimitRpm,
  now: () => number = Date.now
): MiddlewareHandler<{ Variables: AppVariables }> {
  const windows = new Map<string, Window>();

  return async (c, next) => {
    const userId = c.var.user.id;
    const t = now();
    let w = windows.get(userId);

    if (!w || t >= w.resetAt) {
      w = { count: 0, resetAt: t + WINDOW_MS };
      windows.set(userId, w);
    }

    w.count += 1;

    if (w.count > rpm) {
      const retryAfter = Math.ceil((w.resetAt - t) / 1000);
      c.header("Retry-After", String(Math.max(1, retryAfter)));
      return c.json({ error: "rate_limited", reason: "too_many_requests" }, 429);
    }

    await next();
  };
}

export const rateLimit = createRateLimiter();
