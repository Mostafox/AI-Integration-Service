import { describe, it, expect, vi } from "vitest";
import { Summarizer } from "../src/core/summarizer.js";
import { KeyPool } from "../src/core/keyPool.js";
import type { ChatRepo } from "../src/core/chatRepo.js";
import type { OpenRouterClient } from "../src/core/openrouter.js";
import type { Chat, Message } from "../src/core/types.js";

function msg(i: number, role: "user" | "assistant"): Message {
  return {
    id: `m${i}`,
    chatId: "c1",
    role,
    content: `message ${i}`,
    promptTokens: null,
    completionTokens: null,
    finishReason: null,
    createdAt: new Date(2026, 5, 14, 0, 0, i),
  };
}

function chat(overrides: Partial<Chat> = {}): Chat {
  return {
    id: "c1",
    userId: "u1",
    model: "m",
    title: "t",
    summary: null,
    summarizedThrough: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeRepo(messages: Message[]) {
  return {
    getUnsummarizedMessages: vi.fn(async () => messages),
    updateSummary: vi.fn(async () => undefined),
  } as unknown as ChatRepo;
}

function makeOpenRouter(text = "SUMMARY") {
  const complete = vi.fn(async () => ({ text }));
  return { client: { complete } as unknown as OpenRouterClient, complete };
}

const opts = { summarizeAfterMessages: 4, keepRecentMessages: 2, model: "sum" };

describe("Summarizer", () => {
  it("is a no-op when under the threshold", async () => {
    const repo = makeRepo([msg(1, "user"), msg(2, "assistant")]);
    const { client, complete } = makeOpenRouter();
    const s = new Summarizer(repo, client, new KeyPool(["k"]), opts);

    const res = await s.summarizeIfNeeded(chat());
    expect(res.summarized).toBe(false);
    expect(complete).not.toHaveBeenCalled();
    expect((repo.updateSummary as any)).not.toHaveBeenCalled();
  });

  it("folds the oldest turns, keeping the most recent, and advances the boundary", async () => {
    const messages = [
      msg(1, "user"),
      msg(2, "assistant"),
      msg(3, "user"),
      msg(4, "assistant"),
      msg(5, "user"),
      msg(6, "assistant"),
    ];
    const repo = makeRepo(messages);
    const { client } = makeOpenRouter("FOLDED");
    const s = new Summarizer(repo, client, new KeyPool(["k"]), opts);

    const res = await s.summarizeIfNeeded(chat());
    expect(res.summarized).toBe(true);
    // 6 messages, keep 2 → fold 4.
    expect(res.folded).toBe(4);
    expect(res.summary).toBe("FOLDED");
    // Boundary is the 4th message's timestamp.
    expect(res.summarizedThrough).toEqual(messages[3].createdAt);
    expect(repo.updateSummary).toHaveBeenCalledWith("c1", "FOLDED", messages[3].createdAt);
  });

  it("incorporates the existing summary into the fold prompt", async () => {
    const messages = [
      msg(1, "user"),
      msg(2, "assistant"),
      msg(3, "user"),
      msg(4, "assistant"),
      msg(5, "user"),
    ];
    const repo = makeRepo(messages);
    const { client, complete } = makeOpenRouter();
    const s = new Summarizer(repo, client, new KeyPool(["k"]), opts);

    await s.summarizeIfNeeded(chat({ summary: "PRIOR SUMMARY" }));
    const promptArg = complete.mock.calls[0][2] as { role: string; content: string }[];
    const userTurn = promptArg.find((p) => p.role === "user");
    expect(userTurn?.content).toContain("PRIOR SUMMARY");
  });
});
