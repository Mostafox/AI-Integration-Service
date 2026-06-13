import "dotenv/config";
import { SignJWT } from "jose";

/**
 * Mint a test end-user JWT for local verification.
 *
 *   npm run mint-jwt -- <userId> [ttlSeconds]
 *
 * Uses HS256 with JWT_SECRET from the environment. The user id is placed in the
 * claim named by JWT_USER_CLAIM (default "sub").
 */

async function main() {
  const userId = process.argv[2] ?? "user-test-1";
  const ttl = Number(process.argv[3] ?? 3600);
  const secret = process.env.JWT_SECRET;
  const claim = process.env.JWT_USER_CLAIM ?? "sub";

  if (!secret) {
    console.error("JWT_SECRET is not set (this script signs HS256 tokens).");
    process.exit(1);
  }

  const key = new TextEncoder().encode(secret);
  const now = Math.floor(Date.now() / 1000);

  const token = await new SignJWT({ [claim]: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(now)
    .setExpirationTime(now + ttl)
    .sign(key);

  // Print just the token so it's easy to capture in a shell variable.
  console.log(token);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
