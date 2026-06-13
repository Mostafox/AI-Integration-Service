import type { ChatRepo } from "./chatRepo.js";
import type { KeyPool } from "./keyPool.js";
import { OpenRouterRateLimitError, type OpenRouterClient } from "./openrouter.js";
import type { Chat, ChatMessage, Message } from "./types.js";

/**
 * Condenses old turns into a running summary so the prompt stays bounded
 * regardless of chat length. Always runs under the per-chat lock (caller's
 * responsibility) so it can't double-run.
 *
 * When the count of un-summarized user/assistant messages exceeds
 * `summarizeAfterMessages`, the oldest `(count - keepRecent)` of them are folded
 * (together with any existing summary) into a new summary, and
 * `summarized_through` advances to the last folded message's timestamp.
 */

const SUMMARY_SYSTEM_PROMPT =
  "You compress chat history. Produce a concise, faithful summary that preserves " +
  "facts, decisions, names, numbers, and any open questions or tasks. Write it as " +
  "neutral notes the assistant can rely on to continue the conversation. Do not add " +
  "information that is not present.";

export interface SummarizerOptions {
  summarizeAfterMessages: number;
  keepRecentMessages: number;
  model: string;
}

export interface SummarizeResult {
  summarized: boolean;
  /** New summary text (only when summarized). */
  summary?: string;
  /** New summarized_through boundary (only when summarized). */
  summarizedThrough?: Date;
  /** How many messages were folded. */
  folded?: number;
}

export class Summarizer {
  constructor(
    private readonly repo: ChatRepo,
    private readonly openrouter: OpenRouterClient,
    private readonly keyPool: KeyPool,
    private readonly opts: SummarizerOptions
  ) {}

  /** True if this chat currently warrants summarization. */
  needsSummary(unsummarizedCount: number): boolean {
    return unsummarizedCount > this.opts.summarizeAfterMessages;
  }

  /**
   * Summarize if needed. Persists the new summary + boundary via the repo and
   * returns what happened. No-op (summarized:false) when under threshold.
   */
  async summarizeIfNeeded(chat: Chat): Promise<SummarizeResult> {
    const messages = await this.repo.getUnsummarizedMessages(
      chat.id,
      chat.summarizedThrough
    );

    if (!this.needsSummary(messages.length)) return { summarized: false };

    const foldCount = messages.length - this.opts.keepRecentMessages;
    if (foldCount <= 0) return { summarized: false };

    const toFold = messages.slice(0, foldCount);
    const boundary = toFold[toFold.length - 1].createdAt;

    const summary = await this.runSummary(chat.summary, toFold);
    await this.repo.updateSummary(chat.id, summary, boundary);

    return {
      summarized: true,
      summary,
      summarizedThrough: boundary,
      folded: foldCount,
    };
  }

  private async runSummary(
    existingSummary: string | null,
    toFold: Message[]
  ): Promise<string> {
    const transcript = toFold
      .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
      .join("\n");

    const userContent = existingSummary
      ? `Existing summary so far:\n${existingSummary}\n\n` +
        `New turns to fold into it:\n${transcript}\n\n` +
        `Produce an updated combined summary.`
      : `Summarize the following conversation turns:\n${transcript}`;

    const prompt: ChatMessage[] = [
      { role: "system", content: SUMMARY_SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ];

    // One OpenRouter call through the key pool. Transparently retry once on a
    // different key if the first is rate-limited (no streaming here).
    const lease = this.keyPool.acquire();
    try {
      const { text } = await this.openrouter.complete(lease.key, this.opts.model, prompt);
      return text.trim();
    } catch (err) {
      if (err instanceof OpenRouterRateLimitError) {
        this.keyPool.cooldown(lease.key, err.retryAfterMs);
        lease.release();
        const retry = this.keyPool.acquire();
        try {
          const { text } = await this.openrouter.complete(
            retry.key,
            this.opts.model,
            prompt
          );
          return text.trim();
        } finally {
          retry.release();
        }
      }
      throw err;
    } finally {
      lease.release();
    }
  }
}
