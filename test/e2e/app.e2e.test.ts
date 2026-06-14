import "dotenv/config";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * End-to-end tests against a LIVE server (the Docker stack on BASE_URL).
 *
 * Run the stack first, then:  npm run test:e2e
 *   E2E_BASE_URL (default http://localhost:3000)
 *   JWT_SECRET   (must match the server's — both read it from .env)
 *
 * Note: we use E2E_BASE_URL, not BASE_URL — Vite/Vitest reserves BASE_URL
 * (its base-path, default "/") and would otherwise clobber it.
 *
 * These tests do NOT depend on a working OpenRouter key: the streaming send is
 * asserted up to the point the service controls (the `chat` event + user-message
 * persistence). The model reply may terminate with either a `done` event (keys
 * work) or an `error` event (e.g. all_keys_cooling) — both are accepted.
 */

// Use `||` (not `??`) so an empty-string env var also falls back to the default.
const BASE_URL = (process.env.E2E_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const JWT_SECRET = process.env.JWT_SECRET || "dev-super-secret-change-me";
const JWT_ALG = process.env.JWT_ALG || "HS256";
const USER_CLAIM = process.env.JWT_USER_CLAIM || "sub";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function mintToken(userId: string, ttlSeconds = 3600): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ [USER_CLAIM]: userId })
    .setProtectedHeader({ alg: JWT_ALG })
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .sign(new TextEncoder().encode(JWT_SECRET));
}

interface SseEvent {
  event: string;
  data: unknown;
}

/** Parse an SSE response body into a list of {event, data(JSON-parsed)}. */
function parseSse(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const block of text.split(/\n\n+/)) {
    const lines = block.split("\n");
    let event = "message";
    let data = "";
    for (const line of lines) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (!data) continue;
    let parsed: unknown = data;
    try {
      parsed = JSON.parse(data);
    } catch {
      /* leave as string */
    }
    events.push({ event, data: parsed });
  }
  return events;
}

interface PostResult {
  status: number;
  contentType: string;
  json?: any;
  events?: SseEvent[];
  retryAfter?: string | null;
}

/** POST helper that understands both JSON error responses and SSE streams. */
async function post(
  path: string,
  body: unknown,
  token?: string
): Promise<PostResult> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const contentType = res.headers.get("content-type") ?? "";
  const result: PostResult = {
    status: res.status,
    contentType,
    retryAfter: res.headers.get("retry-after"),
  };
  const text = await res.text();
  if (contentType.includes("text/event-stream")) result.events = parseSse(text);
  else if (text) {
    try {
      result.json = JSON.parse(text);
    } catch {
      result.json = text;
    }
  }
  return result;
}

async function getJson(path: string, token?: string) {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE_URL}${path}`, { headers });
  let json: any;
  try {
    json = await res.json();
  } catch {
    json = undefined;
  }
  return { status: res.status, json };
}

beforeAll(async () => {
  try {
    const res = await fetch(`${BASE_URL}/health`);
    if (!res.ok) throw new Error(`/health returned ${res.status}`);
  } catch (e) {
    throw new Error(
      `Cannot reach the server at ${BASE_URL}. Start the stack first ` +
        `(docker compose up) and ensure JWT_SECRET matches. Cause: ${(e as Error).message}`
    );
  }
});

describe("health", () => {
  it("GET /health is public and reports key-pool status", async () => {
    const { status, json } = await getJson("/health");
    expect(status).toBe(200);
    expect(json.status).toBe("ok");
    expect(Array.isArray(json.keys)).toBe(true);
    expect(json.keys.length).toBeGreaterThan(0);
    // Keys must be masked — never expose full secrets on a public route.
    for (const k of json.keys) expect(k.masked).toMatch(/^\.\.\./);
  });
});

describe("auth", () => {
  it("rejects requests with no token (401)", async () => {
    const { status } = await getJson("/v1/chats");
    expect(status).toBe(401);
  });

  it("rejects an invalid token (401)", async () => {
    const { status } = await getJson("/v1/chats", "not.a.jwt");
    expect(status).toBe(401);
  });

  it("accepts a valid token", async () => {
    const token = await mintToken(`u-${randomUUID()}`);
    const { status, json } = await getJson("/v1/chats", token);
    expect(status).toBe(200);
    expect(json).toHaveProperty("activeChatId");
  });
});

describe("validation & chat resolution", () => {
  it("400 when new_chat is true without a system_prompt", async () => {
    const token = await mintToken(`u-${randomUUID()}`);
    const r = await post("/v1/messages", { new_chat: true, message: "hi" }, token);
    expect(r.status).toBe(400);
    expect(r.json.reason).toBe("validation_failed");
  });

  it("400 on an empty message", async () => {
    const token = await mintToken(`u-${randomUUID()}`);
    const r = await post("/v1/messages", { message: "" }, token);
    expect(r.status).toBe(400);
  });

  it("409 when appending with no active chat", async () => {
    const token = await mintToken(`u-${randomUUID()}`);
    const r = await post("/v1/messages", { message: "hello" }, token);
    expect(r.status).toBe(409);
    expect(r.json.reason).toBe("no_active_chat");
  });
});

describe("send → persist → fetch (per-user isolated)", () => {
  const userId = `u-${randomUUID()}`;
  let token: string;
  let chatId: string;

  beforeAll(async () => {
    token = await mintToken(userId);
  });

  it("starts a chat: SSE emits a `chat` event then a terminal event", async () => {
    const r = await post(
      "/v1/messages",
      {
        new_chat: true,
        system_prompt: "You are terse.",
        title: "e2e title",
        message: "count to 5",
      },
      token
    );

    expect(r.status).toBe(200);
    expect(r.contentType).toContain("text/event-stream");

    const chatEvent = r.events!.find((e) => e.event === "chat");
    expect(chatEvent, "expected a `chat` SSE event").toBeDefined();
    chatId = (chatEvent!.data as { chatId: string }).chatId;
    expect(chatId).toMatch(UUID_RE);

    // Terminal event is either a clean `done` or an `error` (e.g. no usable key).
    const terminal = r.events!.find((e) => e.event === "done" || e.event === "error");
    expect(terminal, "expected a terminal done/error event").toBeDefined();
    if (terminal!.event === "done") {
      const d = terminal!.data as { usage: unknown; finishReason: string };
      expect(d.usage).toBeDefined();
    }
  });

  it("persists the chat with system + user messages (assistant if the model replied)", async () => {
    const { status, json } = await getJson(`/v1/chats/${chatId}`, token);
    expect(status).toBe(200);
    expect(json.chat.id).toBe(chatId);
    expect(json.chat.title).toBe("e2e title");

    const roles = json.messages.map((m: any) => m.role);
    expect(roles[0]).toBe("system");
    expect(json.messages[0].content).toBe("You are terse.");
    expect(roles).toContain("user");
    const firstUser = json.messages.find((m: any) => m.role === "user");
    expect(firstUser.content).toBe("count to 5");
  });

  it("sets the active-chat pointer so a follow-up appends without new_chat", async () => {
    const active = await getJson("/v1/chats", token);
    expect(active.json.activeChatId).toBe(chatId);

    const r = await post("/v1/messages", { message: "now count to 10" }, token);
    expect(r.status).toBe(200);
    const chatEvent = r.events!.find((e) => e.event === "chat");
    // Same chat resolved implicitly from the pointer.
    expect((chatEvent!.data as { chatId: string }).chatId).toBe(chatId);

    const { json } = await getJson(`/v1/chats/${chatId}`, token);
    const userMsgs = json.messages.filter((m: any) => m.role === "user").map((m: any) => m.content);
    expect(userMsgs).toContain("now count to 10");
  });

  it("enforces ownership: another user gets 404 for this chat", async () => {
    const otherToken = await mintToken(`u-${randomUUID()}`);
    const { status } = await getJson(`/v1/chats/${chatId}`, otherToken);
    expect(status).toBe(404);
  });

  it("404 for a non-existent chat id", async () => {
    const { status } = await getJson(`/v1/chats/${randomUUID()}`, token);
    expect(status).toBe(404);
  });
});
