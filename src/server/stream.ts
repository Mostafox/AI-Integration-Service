import type { SSEStreamingApi } from "hono/streaming";
import type { ServiceEvent } from "../core/chatService.js";

/**
 * Adapter: relay ChatService events to the client as Server-Sent Events.
 *
 * Event shapes (all `data` is JSON):
 *   event: chat   -> { "chatId": "..." }      (emitted first)
 *   event: delta  -> { "text": "..." }         (incremental tokens)
 *   event: done   -> { "finishReason", "usage" } (terminal, clean finish)
 *   event: error  -> { "error", "reason" }      (terminal, failure)
 */
export async function relayEvents(
  sse: SSEStreamingApi,
  events: AsyncGenerator<ServiceEvent, void, unknown>
): Promise<void> {
  for await (const ev of events) {
    switch (ev.type) {
      case "chat":
        await sse.writeSSE({ event: "chat", data: JSON.stringify({ chatId: ev.chatId }) });
        break;
      case "delta":
        await sse.writeSSE({ event: "delta", data: JSON.stringify({ text: ev.text }) });
        break;
      case "done":
        await sse.writeSSE({
          event: "done",
          data: JSON.stringify({ finishReason: ev.finishReason, usage: ev.usage }),
        });
        break;
    }
  }
}

export async function writeErrorEvent(
  sse: SSEStreamingApi,
  reason: string
): Promise<void> {
  await sse.writeSSE({
    event: "error",
    data: JSON.stringify({ error: "stream_error", reason }),
  });
}
