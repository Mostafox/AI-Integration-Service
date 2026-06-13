import type { ChatMessage, StreamDelta, TokenUsage } from "./types.js";

/**
 * Minimal OpenRouter client built on native fetch.
 * - streamChat: SSE streaming chat completion (yields text deltas + final usage)
 * - complete: non-streaming completion (used by the summarizer)
 */

export class OpenRouterRateLimitError extends Error {
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number, message = "openrouter_rate_limited") {
    super(message);
    this.name = "OpenRouterRateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

export class OpenRouterError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "OpenRouterError";
    this.status = status;
  }
}

export interface OpenRouterOptions {
  baseUrl: string;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Sent as Referer/X-Title for OpenRouter attribution (optional). */
  appUrl?: string;
  appTitle?: string;
}

function parseRetryAfter(res: Response): number {
  const h = res.headers.get("retry-after");
  if (!h) return 30_000;
  const secs = Number(h);
  if (!Number.isNaN(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(h);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return 30_000;
}

interface UsagePayload {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

function normalizeUsage(u: UsagePayload | undefined): TokenUsage | undefined {
  if (!u) return undefined;
  const promptTokens = u.prompt_tokens ?? 0;
  const completionTokens = u.completion_tokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: u.total_tokens ?? promptTokens + completionTokens,
  };
}

export class OpenRouterClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly appUrl?: string;
  private readonly appTitle?: string;

  constructor(opts: OpenRouterOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.appUrl = opts.appUrl;
    this.appTitle = opts.appTitle;
  }

  private headers(apiKey: string): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };
    if (this.appUrl) h["HTTP-Referer"] = this.appUrl;
    if (this.appTitle) h["X-Title"] = this.appTitle;
    return h;
  }

  /**
   * Stream a chat completion. Yields StreamDelta chunks: incremental text and,
   * on the terminal chunk, token usage + finish reason.
   *
   * Throws OpenRouterRateLimitError on 429 (before any token is yielded) so the
   * caller can rotate keys; throws OpenRouterError on other non-2xx.
   */
  async *streamChat(
    apiKey: string,
    model: string,
    messages: ChatMessage[],
    signal: AbortSignal
  ): AsyncGenerator<StreamDelta, void, unknown> {
    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers(apiKey),
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal,
    });

    if (res.status === 429) {
      throw new OpenRouterRateLimitError(parseRetryAfter(res));
    }
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new OpenRouterError(res.status, `OpenRouter ${res.status}: ${text.slice(0, 500)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE events are separated by blank lines; split on newlines and
        // process complete `data:` lines, keeping any partial tail buffered.
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line || line.startsWith(":")) continue;
          if (!line.startsWith("data:")) continue;

          const data = line.slice(5).trim();
          if (data === "[DONE]") return;

          const delta = this.parseChunk(data);
          if (delta) yield delta;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private parseChunk(data: string): StreamDelta | null {
    let json: any;
    try {
      json = JSON.parse(data);
    } catch {
      return null;
    }

    const out: StreamDelta = {};
    const choice = json.choices?.[0];
    const text = choice?.delta?.content;
    if (typeof text === "string" && text.length > 0) out.text = text;
    if (choice?.finish_reason) out.finishReason = choice.finish_reason;

    const usage = normalizeUsage(json.usage);
    if (usage) out.usage = usage;

    if (out.text === undefined && out.usage === undefined && out.finishReason === undefined) {
      return null;
    }
    return out;
  }

  /**
   * Non-streaming completion. Returns the full text. Used for summarization,
   * where streaming buys nothing.
   */
  async complete(
    apiKey: string,
    model: string,
    messages: ChatMessage[],
    signal?: AbortSignal
  ): Promise<{ text: string; usage?: TokenUsage }> {
    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers(apiKey),
      body: JSON.stringify({ model, messages, stream: false }),
      signal,
    });

    if (res.status === 429) {
      throw new OpenRouterRateLimitError(parseRetryAfter(res));
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new OpenRouterError(res.status, `OpenRouter ${res.status}: ${text.slice(0, 500)}`);
    }

    const json: any = await res.json();
    return {
      text: json.choices?.[0]?.message?.content ?? "",
      usage: normalizeUsage(json.usage),
    };
  }
}
