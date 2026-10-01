import "dotenv/config";
import { Bot } from "grammy";
import { loadConfig } from "../config/env.js";
import { createLogger } from "../utils/logger.js";
import { createDatabase } from "../db/client.js";
import { createMiniAppServer, listenMiniApp } from "./server.js";

/** Optional separate Mini App service. It uses the same database/token, but never starts a second polling bot. */
async function main() {
  const config = loadConfig();
  const logger = createLogger(config);
  const db = createDatabase(config.databaseUrl, config.databasePoolSize, logger, config.nodeEnv);
  try {
    await db.init!();
    const me = await new Bot(config.botToken).api.getMe();
    const server = createMiniAppServer({ config, logger, prisma: () => db.prisma, isReady: () => true, botUsername: () => me.username });
    await listenMiniApp(server, config.port ?? 3000);
    logger.info({ port: config.port ?? 3000 }, "Iris Mini App server ready");
    let stopping = false;
    const stop = async () => {
      if (stopping) return; stopping = true;
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
      await db.close();
    };
    process.once("SIGINT", () => void stop());
    process.once("SIGTERM", () => void stop());
  } catch (error) { await db.close(); throw error; }
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Mini App could not start"); process.exitCode = 1; });
