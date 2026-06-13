import {
  pgTable,
  uuid,
  text,
  integer,
  bigint,
  timestamp,
  date,
  pgEnum,
  index,
  primaryKey,
} from "drizzle-orm/pg-core";

/**
 * Drizzle schema. Postgres is the source of truth; Redis is a disposable cache.
 */

export const roleEnum = pgEnum("message_role", ["system", "user", "assistant"]);

export const chats = pgTable(
  "chats",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    model: text("model").notNull(),
    // Caller-provided title, else auto-generated. Never null.
    title: text("title").notNull(),
    // Running summary of older turns (null until first summarization).
    summary: text("summary"),
    // Messages created at/before this point are folded into `summary`.
    summarizedThrough: timestamp("summarized_through", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userIdx: index("chats_user_id_idx").on(t.userId),
    userCreatedIdx: index("chats_user_created_idx").on(t.userId, t.createdAt),
  })
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    chatId: uuid("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    role: roleEnum("role").notNull(),
    content: text("content").notNull(),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    // "stop" | "interrupted" | "length" | ...
    finishReason: text("finish_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    chatCreatedIdx: index("messages_chat_created_idx").on(t.chatId, t.createdAt),
  })
);

export const userUsage = pgTable(
  "user_usage",
  {
    userId: text("user_id").notNull(),
    // Period bucket (a date for "day", or first-of-month for "month").
    period: date("period").notNull(),
    promptTokens: bigint("prompt_tokens", { mode: "number" }).default(0).notNull(),
    completionTokens: bigint("completion_tokens", { mode: "number" }).default(0).notNull(),
    totalTokens: bigint("total_tokens", { mode: "number" }).default(0).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.period] }),
  })
);

export type ChatRow = typeof chats.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type UserUsageRow = typeof userUsage.$inferSelect;
