import "dotenv/config";
import type { Server } from "node:http";
import { GrammyError, HttpError } from "grammy";
import { loadConfig } from "./config/env.js";
import { createDatabase } from "./db/client.js";
import { createLogger } from "./utils/logger.js";
import { createBot } from "./bot/create-bot.js";
import { registerCommandMenus } from "./bot/command-menu.js";
import { cleanupExpiredResetChallenges } from "./services/admin.service.js";
import { closeHealthServer } from "./http/health.js";
import { createMiniAppServer, listenMiniApp } from "./mini-app/server.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  // Validate production storage before opening an HTTP listener. Configuration
  // errors must exit, not leave a healthy-looking server running without a bot.
  const config = loadConfig();
  const logger = createLogger(config);
  const database = createDatabase(config.databaseUrl, config.databasePoolSize, logger, config.nodeEnv);
  const bot = createBot({ config, database, logger });
  let healthServer: Server | null = null;
  let ready = false;
  let botUsername: string | null = null;
  const rawPort = config.port ?? (config.miniAppUrl ? 3000 : NaN);
  if (Number.isInteger(rawPort) && rawPort >= 1 && rawPort <= 65535) {
    try {
      healthServer = createMiniAppServer({ config, logger, prisma: () => database.prisma, isReady: () => ready, botUsername: () => botUsername });
      await listenMiniApp(healthServer, rawPort);
      logger.info({ port: rawPort }, "Iris Mini App and API server listening");
    } catch (error) {
      console.warn(
        "Could not bind health check server on PORT:",
        error instanceof Error ? error.message : "unknown error",
      );
    }
  }

  let stopping = false;

  const shutdown = async (signal: string, exitCode = 0): Promise<void> => {
    if (stopping) return;
    stopping = true;
    ready = false;
    logger.info({ signal }, "Graceful shutdown started");
    await Promise.resolve(bot.stop()).catch((error: unknown) => {
      logger.warn({ err: error }, "Error while stopping bot polling");
    });
    await closeHealthServer(healthServer);
    try {
      await database.close();
      logger.info("Database connection closed");
    } catch (error) {
      logger.error({ err: error }, "Error while closing database");
      exitCode = 1;
    }
    process.exitCode = exitCode;
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("uncaughtException", (error) => {
    logger.fatal({ err: error }, "Uncaught exception");
    void shutdown("uncaughtException", 1);
  });
  process.on("unhandledRejection", (reason) => {
    logger.error({ err: reason }, "Unhandled promise rejection");
  });

  try {
    if (database.init) {
      await database.init();
    } else {
      await database.prisma.$connect();
      await database.prisma.$queryRaw`SELECT 1`;
    }

    try {
      await cleanupExpiredResetChallenges(database.prisma);
    } catch (error) {
      logger.warn({ err: error }, "Could not clean up expired reset challenges at startup");
    }

    const me = await bot.api.getMe();
    botUsername = me.username;

    try {
      await bot.api.deleteWebhook({ drop_pending_updates: false });
    } catch (error) {
      logger.warn({ err: error }, "Could not delete existing webhook before polling");
    }

    await registerCommandMenus(bot.api, config.ownerId, logger, config.miniAppUrl);

    logger.info({ username: me.username, ownerId: config.ownerId.toString() }, "Iris bot connected");

    while (!stopping) {
      try {
        await bot.start({
          allowed_updates: ["message", "callback_query"],
          onStart: () => {
            ready = !stopping;
            logger.info("Long polling started");
          },
        });
        ready = false;
        break;
      } catch (error) {
        ready = false;
        if (stopping) break;
        if (error instanceof GrammyError && error.error_code === 409) {
          logger.warn(
            "Telegram returned 409 Conflict (previous instance still polling during deploy handoff); retrying in 5s",
          );
          await sleep(5_000);
          continue;
        }
        if (
          error instanceof HttpError ||
          (error instanceof GrammyError && (error.error_code === 429 || error.error_code >= 500))
        ) {
          const retrySeconds =
            error instanceof GrammyError && typeof error.parameters?.retry_after === "number"
              ? error.parameters.retry_after
              : 5;
          logger.warn({ err: error, retrySeconds }, "Transient Telegram polling error; retrying");
          await sleep(retrySeconds * 1_000);
          continue;
        }
        throw error;
      }
    }
  } catch (error) {
    logger.fatal({ err: error }, "Iris could not start");
    await shutdown("startup-error", 1);
  }
}

main().catch((error: unknown) => {
  // Covers config parsing before the structured logger can be created.
  console.error("Iris startup failed:", error instanceof Error ? error.message : "unknown error");
  process.exitCode = 1;
});
