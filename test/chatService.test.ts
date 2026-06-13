import { describe, it, expect, vi } from "vitest";
import {
  ChatService,
  ChatBusyError,
  NoActiveChatError,
  type ServiceEvent,
  type ChatServiceDeps,
} from "../src/core/chatService.js";
import { KeyPool } from "../src/core/keyPool.js";
import type { Chat, ChatContext, Message, StreamDelta } from "../src/core/types.js";

/** Collect all events a send() generator emits. */
async function collect(
  gen: AsyncGenerator<ServiceEvent, void, unknown>
): Promise<ServiceEvent[]> {
  const out: ServiceEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

function fakeChat(id = "c1"): Chat {
  return {
    id,
    userId: "u1",
    model: "test-model",
    title: "t",
    summary: null,
    summarizedThrough: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function fakeContext(id = "c1"): ChatContext {
  return {
    chatId: id,
    userId: "u1",
    model: "test-model",
    systemPrompt: "be terse",
    summary: null,
    recent: [],
  };
}

/** Build a ChatService with controllable fakes; returns service + spies. */
function build(opts: {
  streamDeltas?: StreamDelta[];
  streamThrows?: Error;
  lockGranted?: boolean;
  hasActiveChat?: boolean;
  withinBudget?: boolean;
}) {
  const inserted: Message[] = [];

  const repo = {
    createChat: vi.fn(async () => ({ chat: fakeChat(), system: {} as Message })),
    getChat: vi.fn(async () => fakeChat()),
    getLatestChatId: vi.fn(async () => (opts.hasActiveChat ? "c1" : null)),
    insertMessage: vi.fn(async (input: any) => {
      const m: Message = {
        id: `m${inserted.length}`,
        chatId: input.chatId,
        role: input.role,
        content: input.content,
        promptTokens: input.promptTokens ?? null,
        completionTokens: input.completionTokens ?? null,
        finishReason: input.finishReason ?? null,
        createdAt: new Date(),
      };
      inserted.push(m);
      return m;
    }),
    buildContext: vi.fn(async () => fakeContext()),
  };

  const cache = {
    getActiveChatId: vi.fn(async () => (opts.hasActiveChat ? "c1" : null)),
    setActiveChatId: vi.fn(async () => undefined),
    getContext: vi.fn(async () => null),
    setContext: vi.fn(async () => undefined),
    invalidate: vi.fn(async () => undefined),
  };

  const releaseLock = vi.fn(async () => undefined);
  const lock = {
    acquire: vi.fn(async () =>
      opts.lockGranted === false ? null : { release: releaseLock }
    ),
  };

  const openrouter = {
    streamChat: async function* (): AsyncGenerator<StreamDelta> {
      if (opts.streamThrows && (opts.streamDeltas?.length ?? 0) === 0) {
        throw opts.streamThrows;
      }
      for (const d of opts.streamDeltas ?? []) yield d;
      if (opts.streamThrows) throw opts.streamThrows;
    },
  };

  const summarizer = {
    summarizeIfNeeded: vi.fn(async () => ({ summarized: false })),
  };

  const usageAdd = vi.fn(async () => undefined);
  const usage = {
    withinBudget: vi.fn(async () => opts.withinBudget !== false),
    add: usageAdd,
  };

  const deps = {
    repo,
    cache,
    lock,
    keyPool: new KeyPool(["k1"]),
    openrouter,
    summarizer,
    usage,
    defaultModel: "test-model",
  } as unknown as ChatServiceDeps;

  return {
    service: new ChatService(deps),
    repo,
    cache,
    usageAdd,
    releaseLock,
    inserted,
  };
}

describe("ChatService.send", () => {
  it("streams deltas, persists user then assistant, records usage", async () => {
    const { service, inserted, usageAdd, releaseLock, cache } = build({
      streamDeltas: [
        { text: "Hello" },
        { text: " world" },
        {
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        },
      ],
    });

    const ctrl = new AbortController();
    const events = await collect(
      service.send({
        user: { id: "u1" },
        body: { message: "hi", newChat: true, systemPrompt: "be terse" },
        signal: ctrl.signal,
      })
    );

    expect(events[0]).toEqual({ type: "chat", chatId: "c1" });
    expect(events.filter((e) => e.type === "delta")).toHaveLength(2);
    const done = events.find((e) => e.type === "done");
    expect(done).toMatchObject({ finishReason: "stop" });

    // user message persisted before assistant.
    expect(inserted[0].role).toBe("user");
    expect(inserted[1].role).toBe("assistant");
    expect(inserted[1].content).toBe("Hello world");
    expect(inserted[1].finishReason).toBe("stop");

    expect(usageAdd).toHaveBeenCalledWith("u1", {
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    });
    // cache refreshed + lock released.
    expect(cache.setContext).toHaveBeenCalled();
    expect(releaseLock).toHaveBeenCalled();
  });

  it("persists a partial reply flagged interrupted on client disconnect", async () => {
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    const { service, inserted, releaseLock } = build({
      streamDeltas: [{ text: "par" }, { text: "tial" }],
      streamThrows: abortErr,
    });

    const ctrl = new AbortController();
    const events = await collect(
      service.send({
        user: { id: "u1" },
        body: { message: "hi", newChat: true, systemPrompt: "x" },
        signal: ctrl.signal,
      })
    );

    // No clean "done" event on an interrupted stream.
    expect(events.find((e) => e.type === "done")).toBeUndefined();
    const assistant = inserted.find((m) => m.role === "assistant")!;
    expect(assistant.content).toBe("partial");
    expect(assistant.finishReason).toBe("interrupted");
    expect(releaseLock).toHaveBeenCalled();
  });

  it("rejects a concurrent message for the same chat with ChatBusyError", async () => {
    const { service } = build({ lockGranted: false, hasActiveChat: true });
    const gen = service.send({
      user: { id: "u1" },
      body: { message: "hi" },
      signal: new AbortController().signal,
    });
    await expect(gen.next()).rejects.toBeInstanceOf(ChatBusyError);
  });

  it("throws NoActiveChatError when appending without an active chat", async () => {
    const { service } = build({ hasActiveChat: false });
    const gen = service.send({
      user: { id: "u1" },
      body: { message: "hi" },
      signal: new AbortController().signal,
    });
    await expect(gen.next()).rejects.toBeInstanceOf(NoActiveChatError);
  });
});
