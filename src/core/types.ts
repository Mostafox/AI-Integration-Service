/**
 * Framework-agnostic domain types shared across the core library and server.
 */

export type Role = "system" | "user" | "assistant";

export type FinishReason = "stop" | "interrupted" | "length" | "error" | string;

/** A single chat message as stored in Postgres. */
export interface Message {
  id: string;
  chatId: string;
  role: Role;
  content: string;
  promptTokens: number | null;
  completionTokens: number | null;
  finishReason: FinishReason | null;
  createdAt: Date;
}

/** A chat row (metadata + running summary). */
export interface Chat {
  id: string;
  userId: string;
  model: string;
  title: string;
  summary: string | null;
  summarizedThrough: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Minimal message shape sent to OpenRouter. */
export interface ChatMessage {
  role: Role;
  content: string;
}

/**
 * The bounded context we cache and feed to the model:
 * system prompt + running summary + most-recent verbatim messages.
 */
export interface ChatContext {
  chatId: string;
  userId: string;
  model: string;
  systemPrompt: string;
  summary: string | null;
  /** Recent un-summarized messages in chronological order (user/assistant). */
  recent: ChatMessage[];
}

/** Token usage as reported by OpenRouter's final stream chunk. */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** Parsed/validated body of POST /v1/messages. */
export interface SendMessageRequest {
  message: string;
  newChat?: boolean;
  systemPrompt?: string;
  title?: string;
  model?: string;
}

/** Authenticated user extracted from JWT claims. */
export interface AuthUser {
  id: string;
}

/** A streamed delta from the OpenRouter SSE relay. */
export interface StreamDelta {
  /** Text token(s) to forward to the client. */
  text?: string;
  /** Final usage, present on the last chunk when include_usage is set. */
  usage?: TokenUsage;
  /** Finish reason reported by the model on the terminal chunk. */
  finishReason?: FinishReason;
}
