# AI-Interaction Microservice

A focused microservice whose only job is **AI interaction**. An authenticated end
user sends a message; the service loads that user's **active chat**, sends
history + the new message to **OpenRouter**, and **streams** the reply back over
SSE. Chats are persisted in **Postgres** (source of truth) and cached in
**Redis** (5-minute TTL) on the hot read path.

Chat is **implicit per user** — the client never manages chat IDs on the send
path. `user_id` comes from the end-user JWT; `new_chat: true` starts a new chat
(and sets it active), otherwise the message appends to the active chat.

## Highlights

- **OpenRouter key rotation** — multiple keys, least-in-flight selection +
  cooldown, transparent pre-token retry across keys.
- **Streaming** — `text/event-stream`, first-token-fast (user-message persist
  runs in parallel with the stream).
- **Mid-stream disconnect** — the partial reply is persisted flagged
  `finish_reason: "interrupted"`.
- **Bounded context** — older turns are folded into a running summary so the
  prompt stays small no matter how long the chat gets.
- **Per-chat lock** (Redis `SET NX PX`) serializes concurrent messages to one
  chat; **per-user rate limit** + **per-user token budget** guard the key pool
  and cost.

## Layout

```
src/
  core/        framework-agnostic library (keyPool, openrouter, chatRepo,
               chatCache, chatLock, summarizer, usage, chatService, types)
  db/          Drizzle schema + client (+ generated migrations)
  server/      thin Hono layer (app, SSE relay, auth + rate-limit middleware)
  config.ts    validated env
  container.ts composition root
  index.ts     boot
test/          vitest unit tests
scripts/       mintJwt.ts (test token)
```

See [progress.md](progress.md) for the implementation checklist.

## Run it (Docker)

```bash
cp .env.example .env        # set OPENROUTER_KEYS=k1,k2,k3 and JWT_SECRET
docker compose up --build   # postgres + redis + migrate + app
curl localhost:3000/health  # 200 with masked key-pool status
```

`docker compose up` brings up Postgres, Redis, runs migrations as a one-shot
`migrate` service, then starts the app. The dev override
(`docker-compose.override.yml`) runs the app via `tsx` with hot-reload.

## Run it (local inner loop)

```bash
npm install
npm run db:generate         # generate SQL migrations from the Drizzle schema
npm run db:migrate          # apply them (needs DATABASE_URL)
npm run dev                 # tsx watch
```

## Try the API

```bash
# 1. Mint a test end-user JWT (uses JWT_SECRET from .env)
TOKEN=$(npm run -s mint-jwt -- user-123)

# 2. Start a chat (SSE: emits a `chat` event with the chatId, then `delta`s)
curl -N -X POST localhost:3000/v1/messages \
  -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"new_chat":true,"system_prompt":"You are terse.","message":"count to 10 slowly"}'

# 3. Continue the same chat (no new_chat / system_prompt — active chat carries over)
curl -N -X POST localhost:3000/v1/messages \
  -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"message":"now count to 20"}'

# 4. Fetch the chat + messages
curl localhost:3000/v1/chats/<chatId> -H "authorization: Bearer $TOKEN"
```

### SSE event shapes

| event   | data                          | when               |
|---------|-------------------------------|--------------------|
| `chat`  | `{ "chatId": "..." }`         | first              |
| `delta` | `{ "text": "..." }`           | each token chunk   |
| `done`  | `{ "finishReason", "usage" }` | clean finish       |
| `error` | `{ "error", "reason" }`       | failure mid-stream |

## Routes

| Method | Path                | Notes |
|--------|---------------------|-------|
| POST   | `/v1/messages`      | Send + SSE stream. Auth + rate-limited + budget-checked. |
| GET    | `/v1/chats/:chatId` | Chat + messages. Ownership-checked (foreign → 404). |
| GET    | `/v1/chats`         | Active chat id for the user. |
| GET    | `/health`           | Liveness + masked key-pool status. Unauthenticated. |

## Tests

```bash
npm test         # unit (hermetic): keyPool, chatCache, chatLock, summarizer, usage, chatService
npm run test:e2e # integration against a LIVE server (bring the stack up first)
```

The e2e suite ([test/e2e/app.e2e.test.ts](test/e2e/app.e2e.test.ts)) hits the running
service over HTTP: health, auth (401), validation (400), no-active-chat (409),
chat creation + persistence, the active-chat pointer, and ownership (404). It
mints its own JWTs from `JWT_SECRET` (same `.env` the server reads) and is
tolerant of OpenRouter being unavailable — the streamed reply may end in a
`done` *or* an `error` event and the test still passes. Override the target with
`E2E_BASE_URL` (default `http://localhost:3000`).

## Configuration

All via env (see [.env.example](.env.example)): `OPENROUTER_KEYS`,
`DATABASE_URL`, `REDIS_URL`, `JWT_SECRET` (or `JWT_PUBLIC_KEY`), `RATE_LIMIT_RPM`,
`USER_TOKEN_BUDGET`, `BUDGET_PERIOD`, `SUMMARIZE_AFTER_MESSAGES`,
`KEEP_RECENT_MESSAGES`, `CACHE_TTL_SECONDS`, `CHAT_LOCK_TTL_MS`, `PORT`.
