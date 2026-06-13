import "dotenv/config";
import { z } from "zod";

/**
 * Centralised, validated configuration. Parsed once at boot; importing modules
 * read from the frozen `config` object. Fail fast on a bad/missing env var.
 */

const csv = (v: string) =>
  v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const EnvSchema = z.object({
  // OpenRouter
  OPENROUTER_KEYS: z
    .string()
    .min(1, "OPENROUTER_KEYS is required (comma-separated)")
    .transform(csv)
    .refine((arr) => arr.length > 0, "OPENROUTER_KEYS must contain at least one key"),
  OPENROUTER_BASE_URL: z.string().url().default("https://openrouter.ai/api/v1"),
  DEFAULT_MODEL: z.string().default("openai/gpt-4o-mini"),
  SUMMARY_MODEL: z.string().default("openai/gpt-4o-mini"),

  // Postgres / Redis
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),

  // Auth
  JWT_SECRET: z.string().optional(),
  JWT_PUBLIC_KEY: z.string().optional(),
  JWT_ALG: z.string().default("HS256"),
  JWT_USER_CLAIM: z.string().default("sub"),

  // Limits
  RATE_LIMIT_RPM: z.coerce.number().int().positive().default(60),
  USER_TOKEN_BUDGET: z.coerce.number().int().positive().default(200_000),
  BUDGET_PERIOD: z.enum(["day", "month"]).default("day"),
  SUMMARIZE_AFTER_MESSAGES: z.coerce.number().int().positive().default(20),
  KEEP_RECENT_MESSAGES: z.coerce.number().int().positive().default(10),

  // Cache / locks
  CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  CHAT_LOCK_TTL_MS: z.coerce.number().int().positive().default(120_000),

  // Server
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.string().default("info"),
  NODE_ENV: z.string().default("development"),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("\n");
  // eslint-disable-next-line no-console
  console.error(`Invalid environment configuration:\n${issues}`);
  process.exit(1);
}

const env = parsed.data;

if (!env.JWT_SECRET && !env.JWT_PUBLIC_KEY) {
  // eslint-disable-next-line no-console
  console.error("Auth misconfigured: set JWT_SECRET (symmetric) or JWT_PUBLIC_KEY (asymmetric).");
  process.exit(1);
}

export const config = Object.freeze({
  openrouter: {
    keys: env.OPENROUTER_KEYS,
    baseUrl: env.OPENROUTER_BASE_URL,
    defaultModel: env.DEFAULT_MODEL,
    summaryModel: env.SUMMARY_MODEL,
  },
  databaseUrl: env.DATABASE_URL,
  redisUrl: env.REDIS_URL,
  auth: {
    secret: env.JWT_SECRET,
    publicKey: env.JWT_PUBLIC_KEY,
    alg: env.JWT_ALG,
    userClaim: env.JWT_USER_CLAIM,
  },
  limits: {
    rateLimitRpm: env.RATE_LIMIT_RPM,
    userTokenBudget: env.USER_TOKEN_BUDGET,
    budgetPeriod: env.BUDGET_PERIOD,
    summarizeAfterMessages: env.SUMMARIZE_AFTER_MESSAGES,
    keepRecentMessages: env.KEEP_RECENT_MESSAGES,
  },
  cache: {
    ttlSeconds: env.CACHE_TTL_SECONDS,
    chatLockTtlMs: env.CHAT_LOCK_TTL_MS,
  },
  server: {
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    nodeEnv: env.NODE_ENV,
  },
});

export type Config = typeof config;
