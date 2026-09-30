import "dotenv/config";
import { loadConfig } from "./config/env.js";
import { createDatabase } from "./db/client.js";
import { createLogger } from "./utils/logger.js";
import { createBot } from "./bot/create-bot.js";
import { cleanupExpiredResetChallenges } from "./services/admin.service.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);
  const database = createDatabase(config.databaseUrl, config.databasePoolSize, logger);
  const bot = createBot({ config, database, logger });
  let stopping = false;

  const shutdown = async (signal: string, exitCode = 0): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "Graceful shutdown started");
    bot.stop();
    try {
      await database.close();
      logger.info("PostgreSQL connection pool closed");
    } catch (error) {
      logger.error({ err: error }, "Error while closing PostgreSQL");
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
    await database.prisma.$connect();
    await database.prisma.$queryRaw`SELECT 1`;
    await cleanupExpiredResetChallenges(database.prisma);
    const me = await bot.api.getMe();
    await bot.api.deleteWebhook({ drop_pending_updates: false });
    await bot.api.setMyCommands([
      { command: "start", description: "Open the Iris store" },
      { command: "store", description: "Browse categories and products" },
      { command: "profile", description: "View your profile and credits" },
      { command: "bonus", description: "Claim your daily credits" },
      { command: "redeem", description: "Redeem a credit code" },
      { command: "orders", description: "View your purchase history" },
      { command: "help", description: "Get help using Iris" },
    ], { scope: { type: "all_private_chats" } });
    await bot.api.setMyCommands([
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
    ], { scope: { type: "chat", chat_id: Number(config.ownerId) } });

    logger.info({ username: me.username, ownerId: config.ownerId.toString() }, "Iris bot connected");
    await bot.start({
      allowed_updates: ["message", "callback_query"],
      onStart: () => logger.info("Long polling started"),
    });
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
