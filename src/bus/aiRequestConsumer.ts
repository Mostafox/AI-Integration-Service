import Redis from "ioredis";
import { hostname } from "os";
import contracts from "@yara/contracts";
import type { Config } from "../config.js";
import type { ChatService } from "../core/chatService.js";
import {
  ChatBusyError,
  NoActiveChatError,
} from "../core/chatService.js";
import type { OpenRouterClient } from "../core/openrouter.js";
import type { KeyPool } from "../core/keyPool.js";
import type { AiQueryPayload } from "@yara/contracts";

const { parseEvent, createEvent, STREAMS, CONSUMER_GROUPS } = contracts;

const STREAM = STREAMS.AI_REQUESTS;
const RESPONSE_STREAM = STREAMS.AI_RESPONSES;
const GROUP = CONSUMER_GROUPS.AI_SERVICE;
const BLOCK_MS = 5_000;
const BATCH_COUNT = 10;
const AUTOCLAIM_IDLE_MS = 30_000;
const REQUEST_TIMEOUT_MS = 60_000;

const ERROR_FALLBACK =
  "متأسفانه در حال حاضر نمی‌توانم پاسخ دهم. لطفاً کمی بعد دوباره تلاش کنید.";

const CHAT_BUSY_FALLBACK =
  "لطفاً چند لحظه صبر کنید و پیام قبلی را تمام کنید، سپس دوباره بپرسید.";

export interface AiRequestConsumerHandle {
  stop(): Promise<void>;
}

export function startAiRequestConsumer(
  chatService: ChatService,
  openrouter: OpenRouterClient,
  keyPool: KeyPool,
  config: Config
): AiRequestConsumerHandle {
  const client = new Redis(config.redisUrl, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
  });

  const consumerName = `${hostname()}:${process.pid}`;
  let running = true;

  const ensureGroup = async (): Promise<void> => {
    try {
      await client.xgroup("CREATE", STREAM, GROUP, "$", "MKSTREAM");
    } catch (err) {
      if (!(err as Error).message.includes("BUSYGROUP")) {
        console.warn(
          JSON.stringify({
            level: "warn",
            msg: "xgroup create failed",
            error: (err as Error).message,
          })
        );
      }
    }
  };

  const publishReply = async (
    payload: AiQueryPayload,
    text: string,
    status: "ok" | "error",
    canAutoSend: boolean,
    errorReason?: string
  ): Promise<void> => {
    const event = createEvent(
      "ai.reply",
      {
        correlationId: payload.correlationId,
        shopId: payload.shopId,
        customerTelegramId: payload.customerTelegramId,
        conversationId: payload.conversationId,
        mode: payload.mode,
        text,
        status,
        canAutoSend,
        errorReason,
      },
      "ai-service"
    );

    await client.xadd(
      RESPONSE_STREAM,
      "*",
      "id",
      event.id,
      "data",
      JSON.stringify(event)
    );
  };

  const runSend = async (
    payload: AiQueryPayload,
    body: {
      message: string;
      newChat: boolean;
      systemPrompt?: string;
      contextPrompt?: string;
    }
  ): Promise<string> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      await chatService.assertWithinBudget(
        `${payload.shopId}:${payload.customerTelegramId}`
      );

      let text = "";
      const stream = chatService.send({
        user: { id: `${payload.shopId}:${payload.customerTelegramId}` },
        body,
        signal: controller.signal,
      });

      for await (const event of stream) {
        if (event.type === "delta" && event.text) {
          text += event.text;
        }
      }

      return text.trim() || ERROR_FALLBACK;
    } finally {
      clearTimeout(timeout);
    }
  };

  /**
   * Whether the seller-backend may auto-send this reply to the customer.
   * `full_auto` always; `suggest`/`off` never (it becomes a draft regardless);
   * `auto_faq` gates on one cheap classification call, defaulting to false on doubt.
   */
  const resolveCanAutoSend = async (
    payload: AiQueryPayload,
    answer: string
  ): Promise<boolean> => {
    if (payload.mode === "full_auto") return true;
    if (payload.mode !== "auto_faq") return false;
    try {
      const lease = keyPool.acquire();
      try {
        const { text } = await openrouter.complete(lease.key, config.openrouter.summaryModel, [
          {
            role: "system",
            content:
              "You gate whether a drafted shop reply may be auto-sent to a customer. " +
              "Answer EXACTLY 'yes' or 'no'. Say 'yes' ONLY if the draft fully and confidently " +
              "answers the customer using the provided shop info; say 'no' if it is uncertain, " +
              "asks the customer to contact the seller, or lacks the information.",
          },
          {
            role: "user",
            content:
              `Shop info:\n${payload.contextPrompt ?? "(none)"}\n\n` +
              `Customer: ${payload.text}\n\nDraft answer: ${answer}\n\nSafe to auto-send?`,
          },
        ]);
        return /^\s*(yes|بله)/i.test(text.trim());
      } finally {
        lease.release();
      }
    } catch {
      return false; // any failure → safer to draft
    }
  };

  const handleQuery = async (payload: AiQueryPayload): Promise<void> => {
    try {
      let text: string;
      try {
        text = await runSend(payload, {
          message: payload.text,
          newChat: false,
          contextPrompt: payload.contextPrompt,
        });
      } catch (err) {
        if (err instanceof NoActiveChatError) {
          text = await runSend(payload, {
            message: payload.text,
            newChat: true,
            systemPrompt:
              payload.systemPrompt ?? config.ai.defaultSystemPrompt,
            contextPrompt: payload.contextPrompt,
          });
        } else {
          throw err;
        }
      }

      const canAutoSend = await resolveCanAutoSend(payload, text);
      await publishReply(payload, text, "ok", canAutoSend);
    } catch (err) {
      const name = (err as Error).name || "Error";
      let fallback = ERROR_FALLBACK;
      if (err instanceof ChatBusyError) {
        fallback = CHAT_BUSY_FALLBACK;
      }

      console.error(
        JSON.stringify({
          level: "error",
          msg: "ai.query failed",
          correlationId: payload.correlationId,
          error: (err as Error).message,
          name,
        })
      );

      await publishReply(payload, fallback, "error", false, name);
    }
  };

  const processMessage = async (msgId: string, fields: string[]): Promise<void> => {
    const dataIndex = fields.indexOf("data");
    const raw = dataIndex >= 0 ? fields[dataIndex + 1] : null;

    if (!raw) {
      await client.xack(STREAM, GROUP, msgId).catch(() => undefined);
      return;
    }

    let event;
    try {
      event = parseEvent(JSON.parse(raw));
    } catch (err) {
      console.error(
        JSON.stringify({
          level: "error",
          msg: "failed to parse ai request",
          msgId,
          error: (err as Error).message,
        })
      );
      await client.xack(STREAM, GROUP, msgId).catch(() => undefined);
      return;
    }

    if (event.type !== "ai.query") {
      await client.xack(STREAM, GROUP, msgId).catch(() => undefined);
      return;
    }

    await handleQuery(event.payload as AiQueryPayload);
    await client.xack(STREAM, GROUP, msgId).catch(() => undefined);
  };

  const consume = async (): Promise<void> => {
    while (running) {
      try {
        const results = (await client.xreadgroup(
          "GROUP",
          GROUP,
          consumerName,
          "COUNT",
          BATCH_COUNT,
          "BLOCK",
          BLOCK_MS,
          "STREAMS",
          STREAM,
          ">"
        )) as Array<[string, Array<[string, string[]]>]> | null;

        if (!results) continue;

        for (const [, entries] of results) {
          for (const [msgId, fields] of entries) {
            await processMessage(msgId, fields);
          }
        }
      } catch (err) {
        if (running) {
          console.warn(
            JSON.stringify({
              level: "warn",
              msg: "ai request consumer error",
              error: (err as Error).message,
            })
          );
          await new Promise((r) => setTimeout(r, 1_000));
        }
      }
    }
  };

  const scheduleAutoclaim = (): void => {
    const run = async (): Promise<void> => {
      if (!running) return;
      try {
        await client.xautoclaim(
          STREAM,
          GROUP,
          consumerName,
          AUTOCLAIM_IDLE_MS,
          "0-0",
          "COUNT",
          "50"
        );
      } catch {
        // Redis 6.2+ only
      }
      if (running) setTimeout(run, AUTOCLAIM_IDLE_MS);
    };
    setTimeout(run, AUTOCLAIM_IDLE_MS);
  };

  void (async () => {
    await ensureGroup();
    scheduleAutoclaim();
    await consume();
  })();

  return {
    async stop(): Promise<void> {
      running = false;
      await client.quit().catch(() => undefined);
    },
  };
}
