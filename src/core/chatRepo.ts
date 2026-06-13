import { and, asc, desc, eq, gt } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { chats, messages } from "../db/schema.js";
import type { Chat, ChatContext, Message, Role } from "./types.js";

/**
 * Postgres reads/writes for chats and messages, via Drizzle.
 * Postgres is the source of truth; the cache layer sits in front of this.
 */

function toChat(row: typeof chats.$inferSelect): Chat {
  return {
    id: row.id,
    userId: row.userId,
    model: row.model,
    title: row.title,
    summary: row.summary,
    summarizedThrough: row.summarizedThrough,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toMessage(row: typeof messages.$inferSelect): Message {
  return {
    id: row.id,
    chatId: row.chatId,
    role: row.role,
    content: row.content,
    promptTokens: row.promptTokens,
    completionTokens: row.completionTokens,
    finishReason: row.finishReason,
    createdAt: row.createdAt,
  };
}

export interface CreateChatInput {
  userId: string;
  model: string;
  title: string;
  systemPrompt: string;
}

export interface InsertMessageInput {
  chatId: string;
  role: Role;
  content: string;
  promptTokens?: number | null;
  completionTokens?: number | null;
  finishReason?: string | null;
}

export class ChatRepo {
  constructor(private readonly db: Database) {}

  /** Create a chat plus its initial system message, atomically. */
  async createChat(input: CreateChatInput): Promise<{ chat: Chat; system: Message }> {
    return this.db.transaction(async (tx) => {
      const [chatRow] = await tx
        .insert(chats)
        .values({
          userId: input.userId,
          model: input.model,
          title: input.title,
        })
        .returning();

      const [sysRow] = await tx
        .insert(messages)
        .values({
          chatId: chatRow.id,
          role: "system",
          content: input.systemPrompt,
        })
        .returning();

      return { chat: toChat(chatRow), system: toMessage(sysRow) };
    });
  }

  async getChat(chatId: string): Promise<Chat | null> {
    const [row] = await this.db.select().from(chats).where(eq(chats.id, chatId)).limit(1);
    return row ? toChat(row) : null;
  }

  /** Most-recently created chat for a user — fallback when the cache pointer misses. */
  async getLatestChatId(userId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ id: chats.id })
      .from(chats)
      .where(eq(chats.userId, userId))
      .orderBy(desc(chats.createdAt))
      .limit(1);
    return row?.id ?? null;
  }

  /** All messages for a chat, chronological. Used by GET /v1/chats/:id. */
  async getMessages(chatId: string): Promise<Message[]> {
    const rows = await this.db
      .select()
      .from(messages)
      .where(eq(messages.chatId, chatId))
      .orderBy(asc(messages.createdAt), asc(messages.id));
    return rows.map(toMessage);
  }

  async insertMessage(input: InsertMessageInput): Promise<Message> {
    const [row] = await this.db
      .insert(messages)
      .values({
        chatId: input.chatId,
        role: input.role,
        content: input.content,
        promptTokens: input.promptTokens ?? null,
        completionTokens: input.completionTokens ?? null,
        finishReason: input.finishReason ?? null,
      })
      .returning();
    // Keep chat.updated_at fresh for ordering/eviction heuristics.
    await this.db
      .update(chats)
      .set({ updatedAt: new Date() })
      .where(eq(chats.id, input.chatId));
    return toMessage(row);
  }

  /**
   * Un-summarized user/assistant messages (with timestamps), chronological.
   * Used by the summarizer to decide what to fold and to set summarized_through.
   */
  async getUnsummarizedMessages(
    chatId: string,
    summarizedThrough: Date | null
  ): Promise<Message[]> {
    const rows = await this.db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.chatId, chatId),
          summarizedThrough ? gt(messages.createdAt, summarizedThrough) : undefined
        )
      )
      .orderBy(asc(messages.createdAt), asc(messages.id));
    return rows.filter((r) => r.role !== "system").map(toMessage);
  }

  async updateSummary(
    chatId: string,
    summary: string,
    summarizedThrough: Date
  ): Promise<void> {
    await this.db
      .update(chats)
      .set({ summary, summarizedThrough, updatedAt: new Date() })
      .where(eq(chats.id, chatId));
  }

  /**
   * Build the bounded context for a chat from Postgres: system prompt,
   * running summary, and recent (un-summarized) user/assistant messages.
   */
  async buildContext(chatId: string): Promise<ChatContext | null> {
    const chat = await this.getChat(chatId);
    if (!chat) return null;

    const [systemRow] = await this.db
      .select()
      .from(messages)
      .where(and(eq(messages.chatId, chatId), eq(messages.role, "system")))
      .orderBy(asc(messages.createdAt))
      .limit(1);

    const recentRows = await this.db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.chatId, chatId),
          chat.summarizedThrough
            ? gt(messages.createdAt, chat.summarizedThrough)
            : undefined
        )
      )
      .orderBy(asc(messages.createdAt), asc(messages.id));

    const recent = recentRows
      .filter((r) => r.role !== "system")
      .map((r) => ({ role: r.role, content: r.content }));

    return {
      chatId: chat.id,
      userId: chat.userId,
      model: chat.model,
      systemPrompt: systemRow?.content ?? "",
      summary: chat.summary,
      recent,
    };
  }
}
