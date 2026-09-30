import "dotenv/config";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { GrammyError, HttpError } from "grammy";
import { loadConfig } from "./config/env.js";
import { createDatabase } from "./db/client.js";
import { createLogger } from "./utils/logger.js";
import { createBot } from "./bot/create-bot.js";
import { cleanupExpiredResetChallenges } from "./services/admin.service.js";
import type { AppLogger } from "./utils/logger.js";

const PRIVATE_COMMANDS = [
  { command: "start", description: "Open the Iris store" },
  { command: "store", description: "Browse categories and products" },
  { command: "profile", description: "View your profile and credits" },
  { command: "bonus", description: "Claim your daily credits" },
  { command: "redeem", description: "Redeem a credit code" },
  { command: "orders", description: "View your purchase history" },
  { command: "help", description: "Get help using Iris" },
] as const;

const OWNER_COMMANDS = [
  { command: "admin", description: "Open the owner panel" },
  { command: "gift", description: "Gift credits to one user" },
  { command: "rm", description: "Remove credits from one user" },
  { command: "giftall", description: "Gift credits to active users" },
  { command: "code", description: "Generate redeem codes" },
  { command: "broadcast", description: "Broadcast a message" },
  { command: "stats", description: "View store statistics" },
  { command: "export", description: "Download a JSON export" },
  { command: "addstock", description: "Add digital inventory" },
  { command: "restart", description: "Gracefully restart via PM2" },
  { command: "reset", description: "Arm the two-step store reset" },
] as const;

function startHealthServer(port: number, logger?: AppLogger): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (req.method === "GET" || req.method === "HEAD") {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        if (req.method === "HEAD") {
          res.end();
        } else {
          res.end(JSON.stringify({ status: "ok", service: "iris-credit-store-bot" }));
        }
        return;
      }
      res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "not_found" }));
    });

    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => {
      server.removeListener("error", reject);
      if (logger) {
        logger.info({ port }, "Health check HTTP server listening");
      }
      resolve(server);
    });
  });
}

function closeHealthServer(server: Server | null): Promise<void> {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  let healthServer: Server | null = null;
  const rawPort = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : NaN;
  if (Number.isInteger(rawPort) && rawPort >= 1 && rawPort <= 65535) {
    try {
      healthServer = await startHealthServer(rawPort);
    } catch (error) {
      console.warn(
        "Could not bind health check server on PORT:",
        error instanceof Error ? error.message : "unknown error",
      );
    }
  }

  const config = loadConfig();
  const logger = createLogger(config);
  if (healthServer && config.port) {
    logger.info({ port: config.port }, "Health check HTTP server ready");
  }

  const database = createDatabase(config.databaseUrl, config.databasePoolSize, logger);
  const bot = createBot({ config, database, logger });
  let stopping = false;

  const shutdown = async (signal: string, exitCode = 0): Promise<void> => {
    if (stopping) return;
    stopping = true;
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

    try {
      await bot.api.deleteWebhook({ drop_pending_updates: false });
    } catch (error) {
      logger.warn({ err: error }, "Could not delete existing webhook before polling");
    }

    try {
      await bot.api.setMyCommands([...PRIVATE_COMMANDS], {
        scope: { type: "all_private_chats" },
      });
    } catch (error) {
      logger.warn({ err: error }, "Could not register private chat commands");
    }

    try {
      await bot.api.setMyCommands([...OWNER_COMMANDS], {
        scope: { type: "chat", chat_id: Number(config.ownerId) },
      });
    } catch (error) {
      logger.warn(
        { err: error, ownerId: config.ownerId.toString() },
        "Could not register owner-scoped commands yet (owner may not have started a chat with the bot)",
      );
    }

    logger.info({ username: me.username, ownerId: config.ownerId.toString() }, "Iris bot connected");

    while (!stopping) {
      try {
        await bot.start({
          allowed_updates: ["message", "callback_query"],
          onStart: () => logger.info("Long polling started"),
        });
        break;
      } catch (error) {
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
