# Implementation progress

Living checklist for the AI-interaction microservice. Update after every edit.

## Scaffold
- [x] `package.json`, `tsconfig.json`, `vitest.config.ts`
- [x] `.env.example`
- [x] `src/config.ts` (env loading + validation)
- [x] `.gitignore` / `.dockerignore`

## DB / schema
- [x] `src/db/schema.ts` (chats, messages, user_usage)
- [x] `src/db/index.ts` (pool + drizzle client)
- [x] `drizzle.config.ts`
- [x] migrations generated → `src/db/migrations/0000_init.sql` (3 tables, indexes, fk)

## Cache + active-chat pointer
- [x] `src/core/chatCache.ts` (history get/set/invalidate, 5-min TTL, active-chat pointer)

## Per-chat lock
- [x] `src/core/chatLock.ts` (Redis SET NX PX + safe release via Lua)

## Key pool
- [x] `src/core/keyPool.ts` (least-in-flight + cooldown, all-busy → 503)

## OpenRouter client
- [x] `src/core/openrouter.ts` (streaming chat + summary completion, AbortController)

## Summarizer
- [x] `src/core/summarizer.ts` (fold old turns into running summary)

## Usage / token budget
- [x] `src/core/usage.ts` (Redis counter + user_usage flush + budget check)

## Chat service
- [x] `src/core/chatService.ts` (orchestration: lock -> load -> summarize -> stream -> persist)
- [x] `src/core/types.ts`

## Routes / server
- [x] `src/server/app.ts` (Hono routes)
- [x] `src/server/stream.ts` (SSE relay adapter)
- [x] `src/server/middleware/auth.ts`
- [x] `src/server/middleware/rateLimit.ts`
- [x] `src/index.ts` (boot)

## Docker
- [x] `Dockerfile` (multi-stage)
- [x] `docker-compose.yml` (app + postgres + redis + migrate)
- [x] `docker-compose.override.yml` (dev hot-reload)
- [x] `.dockerignore`

## Tests
- [x] `test/keyPool.test.ts`
- [x] `test/chatCache.test.ts`
- [x] `test/chatLock.test.ts`
- [x] `test/summarizer.test.ts`
- [x] `test/usage.test.ts`
- [x] `test/chatService.test.ts`

## Tooling
- [x] `scripts/mintJwt.ts` (mint a test end-user JWT)
- [x] `README.md` (run + verify instructions)

## Verified locally
- [x] `npm install` (111 packages)
- [x] `tsc --noEmit` clean
- [x] `npm test` → 29/29 passing
- [x] `npm run build` → `dist/index.js`
- [x] `drizzle-kit generate` → migration emitted

## Open / follow-up
- [ ] Wire real OpenRouter keys in `.env` and smoke-test streaming end-to-end
- [ ] `docker compose up` full-stack smoke test (needs Docker running)
