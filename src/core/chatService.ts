import type { ChatCache } from "./chatCache.js";
import type { ChatLock } from "./chatLock.js";
import type { ChatRepo } from "./chatRepo.js";
import { AllKeysBusyError, type KeyPool } from "./keyPool.js";
import { OpenRouterRateLimitError, type OpenRouterClient } from "./openrouter.js";
import type { Summarizer } from "./summarizer.js";
import type { UsageTracker } from "./usage.js";
import type {
  AuthUser,
  ChatContext,
  ChatMessage,
  FinishReason,
  SendMessageRequest,
  StreamDelta,
  TokenUsage,
} from "./types.js";

/**
 * Orchestrates a send: resolve/create chat -> lock -> load -> summarize ->
 * (persist user || stream from OpenRouter) -> relay -> persist assistant +
 * record usage + refresh cache -> release lock/key. On client disconnect the
 * partial assistant reply is persisted flagged `interrupted`.
 */

export class BudgetExceededError extends Error {
  constructor() {
    super("token_budget_exceeded");
    this.name = "BudgetExceededError";
  }
}
export class NoActiveChatError extends Error {
  constructor() {
    super("no_active_chat");
    this.name = "NoActiveChatError";
  }
}
export class ChatBusyError extends Error {
  constructor() {
    super("chat_busy");
    this.name = "ChatBusyError";
  }
}
export class ChatNotFoundError extends Error {
  constructor() {
    super("chat_not_found");
    this.name = "ChatNotFoundError";
  }
}

export type ServiceEvent =
  | { type: "chat"; chatId: string }
  | { type: "delta"; text: string }
  | { type: "done"; finishReason: FinishReason; usage: TokenUsage };

export interface SendInput {
  user: AuthUser;
  body: SendMessageRequest;
  signal: AbortSignal;
}

export interface ChatServiceDeps {
  repo: ChatRepo;
  cache: ChatCache;
  lock: ChatLock;
  keyPool: KeyPool;
  openrouter: OpenRouterClient;
  summarizer: Summarizer;
  usage: UsageTracker;
  defaultModel: string;
}

function autoTitle(message: string): string {
  const trimmed = message.trim().replace(/\s+/g, " ");
  if (trimmed.length > 0) return trimmed.slice(0, 60);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `Chat ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(
    now.getHours()
  )}:${pad(now.getMinutes())}`;
}

/** Flatten a bounded context + new message into the OpenRouter prompt array. */
function buildPrompt(
  ctx: ChatContext,
  newMessage: string,
  contextPrompt?: string
): ChatMessage[] {
  const prompt: ChatMessage[] = [];
  if (ctx.systemPrompt) prompt.push({ role: "system", content: ctx.systemPrompt });
  if (ctx.summary) {
    prompt.push({
      role: "system",
      content: `Summary of earlier conversation:\n${ctx.summary}`,
    });
  }
  if (contextPrompt?.trim()) {
    prompt.push({ role: "system", content: contextPrompt.trim() });
  }
  for (const m of ctx.recent) prompt.push({ role: m.role, content: m.content });
  prompt.push({ role: "user", content: newMessage });
  return prompt;
}

export class ChatService {
  constructor(private readonly deps: ChatServiceDeps) {}

  /**
   * Pre-flight budget check (cheap Redis read). Throws BudgetExceededError when
   * over cap. Call before acquiring locks/keys.
   */
  async assertWithinBudget(userId: string): Promise<void> {
    const ok = await this.deps.usage.withinBudget(userId);
    if (!ok) throw new BudgetExceededError();
  }

  /**
   * Resolve the target chat for this send. Creates a new chat (with system
   * message + active pointer) when `new_chat` is set, else resolves the active
   * chat. Throws NoActiveChatError when there's no active chat to append to.
   */
  private async resolveChat(
    user: AuthUser,
    body: SendMessageRequest
  ): Promise<string> {
    const { repo, cache, defaultModel } = this.deps;

    if (body.newChat) {
      const model = body.model ?? defaultModel;
      const title = body.title?.trim() || autoTitle(body.message);
      const { chat } = await repo.createChat({
        userId: user.id,
        model,
        title,
        systemPrompt: body.systemPrompt ?? "",
      });
      await cache.setActiveChatId(user.id, chat.id);
      return chat.id;
    }

    // Resolve active chat: cache pointer first, Postgres fallback (+ warm).
    const pointer = await cache.getActiveChatId(user.id);
    if (pointer) return pointer;

    const latest = await repo.getLatestChatId(user.id);
    if (!latest) throw new NoActiveChatError();
    await cache.setActiveChatId(user.id, latest);
    return latest;
  }

  /** Load bounded context: Redis-first, Postgres fallback (+ warm cache). */
  private async loadContext(chatId: string): Promise<ChatContext> {
    const cached = await this.deps.cache.getContext(chatId);
    if (cached) return cached;
    const ctx = await this.deps.repo.buildContext(chatId);
    if (!ctx) throw new ChatNotFoundError();
    await this.deps.cache.setContext(ctx);
    return ctx;
  }

  /**
   * Main entry. Returns an async generator of ServiceEvents to relay as SSE.
   * Acquires the per-chat lock; releases it (and any held key) on completion,
   * error, or client disconnect.
   */
  async *send(input: SendInput): AsyncGenerator<ServiceEvent, void, unknown> {
    const { repo, cache, lock, summarizer, usage } = this.deps;
    const { user, body, signal } = input;

    const chatId = await this.resolveChat(user, body);

    const handle = await lock.acquire(chatId);
    if (!handle) throw new ChatBusyError();

    let lease: { key: string; release(): void } | null = null;

    try {
      yield { type: "chat", chatId };

      // Summarize older turns if the chat has grown past the threshold. Runs
      // under the lock; rebuild context afterwards so the prompt is bounded.
      const chat = await repo.getChat(chatId);
      if (!chat) throw new ChatNotFoundError();
      const summary = await summarizer.summarizeIfNeeded(chat);
      if (summary.summarized) await cache.invalidate(chatId);

      const ctx = await this.loadContext(chatId);
      const prompt = buildPrompt(ctx, body.message, body.contextPrompt);

      // (a) Persist the user message in parallel with starting the stream.
      const userPersist = repo
        .insertMessage({ chatId, role: "user", content: body.message })
        .catch((e) => {
          // Surface later; don't crash the stream over a write race.
          return e instanceof Error ? e : new Error(String(e));
        });

      // (b) Acquire a key and start streaming, with pre-token key rotation.
      const stream = this.streamWithRotation(ctx.model, prompt, signal, (l) => {
        lease = l;
      });

      let assistantText = "";
      let finishReason: FinishReason = "stop";
      let tokenUsage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      let interrupted = false;

      try {
        for await (const delta of stream) {
          if (delta.text) {
            assistantText += delta.text;
            yield { type: "delta", text: delta.text };
          }
          if (delta.usage) tokenUsage = delta.usage;
          if (delta.finishReason) finishReason = delta.finishReason;
        }
      } catch (err) {
        if (signal.aborted || (err as Error)?.name === "AbortError") {
          interrupted = true;
          finishReason = "interrupted";
        } else {
          throw err;
        }
      }

      // Ensure the user message landed before writing the assistant message so
      // chronological ordering holds.
      const userResult = await userPersist;
      if (userResult instanceof Error) throw userResult;

      await repo.insertMessage({
        chatId,
        role: "assistant",
        content: assistantText,
        promptTokens: tokenUsage.promptTokens || null,
        completionTokens: tokenUsage.completionTokens || null,
        finishReason,
      });

      if (tokenUsage.totalTokens > 0 || tokenUsage.promptTokens > 0) {
        await usage.add(user.id, tokenUsage);
      }

      // Refresh cache from the source of truth (bounded context) + TTL reset.
      const fresh = await repo.buildContext(chatId);
      if (fresh) await cache.setContext(fresh);
      await cache.setActiveChatId(user.id, chatId);

      if (!interrupted) {
        yield { type: "done", finishReason, usage: tokenUsage };
      }
    } finally {
      if (lease) (lease as { release(): void }).release();
      await handle.release();
    }
  }

  /**
   * Acquire a key and stream; on a 429 *before any token is emitted*, cool the
   * key and transparently retry on the next one. Once tokens have flowed we
   * cannot retry, so the error propagates.
   */
  private async *streamWithRotation(
    model: string,
    prompt: ChatMessage[],
    signal: AbortSignal,
    onLease: (lease: { key: string; release(): void }) => void
  ): AsyncGenerator<StreamDelta, void, unknown> {
    const available = this.deps.keyPool.availableCount();
    const maxAttempts = Math.max(1, available);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let lease: { key: string; release(): void };
      try {
        lease = this.deps.keyPool.acquire();
      } catch (e) {
        if (e instanceof AllKeysBusyError) throw e;
        throw e;
      }
      onLease(lease);

      let emitted = false;
      try {
        for await (const delta of this.deps.openrouter.streamChat(
          lease.key,
          model,
          prompt,
          signal
        )) {
          emitted = true;
          yield delta;
        }
        return; // completed cleanly
      } catch (err) {
        if (err instanceof OpenRouterRateLimitError && !emitted) {
          this.deps.keyPool.cooldown(lease.key, err.retryAfterMs);
          lease.release();
          continue; // try the next key
        }
        throw err; // mid-stream or non-429: cannot retry
      }
    }

    // Every key was rate-limited before emitting a token.
    throw new AllKeysBusyError(Date.now() + 30_000);
  }
}
