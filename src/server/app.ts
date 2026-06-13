import { Hono } from "hono";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { chatCache, chatRepo, chatService, keyPool } from "../container.js";
import {
  BudgetExceededError,
  ChatBusyError,
  ChatNotFoundError,
  NoActiveChatError,
} from "../core/chatService.js";
import { AllKeysBusyError } from "../core/keyPool.js";
import type { SendMessageRequest } from "../core/types.js";
import { auth, type AppVariables } from "./middleware/auth.js";
import { rateLimit } from "./middleware/rateLimit.js";
import { relayEvents, writeErrorEvent } from "./stream.js";

/** Request body for POST /v1/messages (snake_case wire format). */
const SendSchema = z
  .object({
    message: z.string().min(1, "message is required"),
    new_chat: z.boolean().optional(),
    system_prompt: z.string().optional(),
    title: z.string().max(200).optional(),
    model: z.string().optional(),
  })
  .refine((d) => !d.new_chat || (d.system_prompt?.trim().length ?? 0) > 0, {
    message: "system_prompt is required when new_chat is true",
    path: ["system_prompt"],
  });

function mapServiceError(c: Context, err: unknown) {
  if (err instanceof BudgetExceededError) {
    return c.json({ error: "rate_limited", reason: "token_budget_exceeded" }, 429);
  }
  if (err instanceof NoActiveChatError) {
    return c.json({ error: "conflict", reason: "no_active_chat" }, 409);
  }
  if (err instanceof ChatBusyError) {
    return c.json({ error: "conflict", reason: "chat_busy" }, 409);
  }
  if (err instanceof ChatNotFoundError) {
    return c.json({ error: "not_found", reason: "chat_not_found" }, 404);
  }
  if (err instanceof AllKeysBusyError) {
    const retryAfter = Math.max(1, Math.ceil((err.retryAtMs - Date.now()) / 1000));
    c.header("Retry-After", String(retryAfter));
    return c.json({ error: "unavailable", reason: "all_keys_cooling" }, 503);
  }
  // eslint-disable-next-line no-console
  console.error("Unhandled service error:", err);
  return c.json({ error: "internal_error" }, 500);
}

export function createApp() {
  const app = new Hono<{ Variables: AppVariables }>();

  // --- health (unauthenticated, no secrets) ---
  app.get("/health", (c) =>
    c.json({
      status: "ok",
      keys: keyPool.status(),
      availableKeys: keyPool.availableCount(),
    })
  );

  // --- authenticated API ---
  const v1 = new Hono<{ Variables: AppVariables }>();
  v1.use("*", auth);

  // POST /v1/messages — send a message, stream the reply over SSE.
  v1.post("/messages", rateLimit, async (c) => {
    const user = c.var.user;

    // Pre-flight budget check (cheap) before locks/keys.
    try {
      await chatService.assertWithinBudget(user.id);
    } catch (err) {
      return mapServiceError(c, err);
    }

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "bad_request", reason: "invalid_json" }, 400);
    }

    const parsed = SendSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        { error: "bad_request", reason: "validation_failed", issues: parsed.error.issues },
        400
      );
    }

    const body: SendMessageRequest = {
      message: parsed.data.message,
      newChat: parsed.data.new_chat,
      systemPrompt: parsed.data.system_prompt,
      title: parsed.data.title,
      model: parsed.data.model,
    };

    // Client-disconnect signal (aborts upstream + persists partial reply).
    const signal = c.req.raw.signal;
    const events = chatService.send({ user, body, signal });

    // Pull the first event before committing to a 200 SSE response so pre-stream
    // failures (no active chat, chat busy, all keys cooling) map to real codes.
    let firstStep: IteratorResult<{ type: string }, void>;
    try {
      firstStep = (await events.next()) as IteratorResult<{ type: string }, void>;
    } catch (err) {
      return mapServiceError(c, err);
    }

    return streamSSE(c, async (sse) => {
      try {
        // Replay the already-pulled first event, then relay the rest.
        if (!firstStep.done && firstStep.value) {
          const ev = firstStep.value as { type: string; chatId?: string };
          if (ev.type === "chat" && ev.chatId) {
            await sse.writeSSE({ event: "chat", data: JSON.stringify({ chatId: ev.chatId }) });
          }
        }
        await relayEvents(sse, events as Parameters<typeof relayEvents>[1]);
      } catch (err) {
        const reason = err instanceof Error ? err.message : "stream_failed";
        await writeErrorEvent(sse, reason);
        // eslint-disable-next-line no-console
        console.error("Stream error:", err);
      }
    });
  });

  // GET /v1/chats/:chatId — fetch chat + messages (ownership-checked).
  v1.get("/chats/:chatId", async (c) => {
    const user = c.var.user;
    const chatId = c.req.param("chatId");

    const chat = await chatRepo.getChat(chatId);
    // Foreign or missing chat → 404 (don't leak existence).
    if (!chat || chat.userId !== user.id) {
      return c.json({ error: "not_found" }, 404);
    }

    const messages = await chatRepo.getMessages(chatId);
    const cacheTtl = await chatCache.ttl(chatId);

    return c.json({
      chat: {
        id: chat.id,
        title: chat.title,
        model: chat.model,
        summary: chat.summary,
        summarizedThrough: chat.summarizedThrough,
        createdAt: chat.createdAt,
        updatedAt: chat.updatedAt,
      },
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        promptTokens: m.promptTokens,
        completionTokens: m.completionTokens,
        finishReason: m.finishReason,
        createdAt: m.createdAt,
      })),
      cache: { ttlSeconds: cacheTtl },
    });
  });

  // GET /v1/chats — return the user's active chat id (if any).
  v1.get("/chats", async (c) => {
    const user = c.var.user;
    let activeChatId = await chatCache.getActiveChatId(user.id);
    if (!activeChatId) activeChatId = await chatRepo.getLatestChatId(user.id);
    return c.json({ activeChatId });
  });

  app.route("/v1", v1);

  return app;
}
