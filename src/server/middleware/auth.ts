import type { Context, MiddlewareHandler } from "hono";
import { jwtVerify, importSPKI, type JWTPayload, type KeyLike } from "jose";
import { config } from "../../config.js";
import type { AuthUser } from "../../core/types.js";

/**
 * Verifies the end-user JWT signature locally (no network call) and extracts
 * the user id from claims. Any `user_id` in the request body is ignored — the
 * identity always comes from the token.
 */

export type AppVariables = { user: AuthUser };

let cachedPublicKey: KeyLike | null = null;

async function getVerifyKey(): Promise<KeyLike | Uint8Array> {
  if (config.auth.publicKey) {
    if (!cachedPublicKey) {
      cachedPublicKey = await importSPKI(config.auth.publicKey, config.auth.alg);
    }
    return cachedPublicKey;
  }
  return new TextEncoder().encode(config.auth.secret!);
}

function extractUserId(payload: JWTPayload): string | null {
  const claim = payload[config.auth.userClaim];
  if (typeof claim === "string" && claim.length > 0) return claim;
  if (typeof claim === "number") return String(claim);
  return null;
}

function unauthorized(c: Context, reason: string) {
  return c.json({ error: "unauthorized", reason }, 401);
}

export const auth: MiddlewareHandler<{ Variables: AppVariables }> = async (c, next) => {
  const header = c.req.header("authorization") ?? c.req.header("Authorization");
  if (!header || !header.startsWith("Bearer ")) {
    return unauthorized(c, "missing_bearer_token");
  }

  const token = header.slice(7).trim();
  try {
    const key = await getVerifyKey();
    const { payload } = await jwtVerify(token, key, {
      algorithms: [config.auth.alg],
    });
    const userId = extractUserId(payload);
    if (!userId) return unauthorized(c, "missing_user_claim");
    c.set("user", { id: userId });
    await next();
  } catch {
    return unauthorized(c, "invalid_token");
  }
};
