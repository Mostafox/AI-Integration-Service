import { serve } from "@hono/node-server";
import { config } from "./config.js";
import { createApp } from "./server/app.js";
import { closeDb } from "./db/index.js";
import { closeRedis } from "./redis.js";

const app = createApp();

const server = serve(
  { fetch: app.fetch, port: config.server.port },
  (info) => {
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        level: "info",
        msg: "ai-interaction-service listening",
        port: info.port,
        env: config.server.nodeEnv,
        keys: config.openrouter.keys.length,
        defaultModel: config.openrouter.defaultModel,
      })
    );
  }
);

async function shutdown(signal: string) {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ level: "info", msg: "shutting down", signal }));
  server.close();
  await Promise.allSettled([closeRedis(), closeDb()]);
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
