import "dotenv/config";
import { resolve } from "node:path";
import { loadConfig } from "../config/env.js";
import { createLogger } from "../utils/logger.js";
import { createDatabase } from "../db/client.js";
import { createMiniAppServer, listenMiniApp } from "./server.js";
import { seedMiniDemo } from "./demo.js";

async function main() {
  if (process.env.NODE_ENV?.trim().toLowerCase() === "production") {
    throw new Error("The demo command is disabled in production. Use npm start or npm run mini:serve.");
  }
  const config = loadConfig({
    ...process.env, NODE_ENV: "development", DATABASE_URL: "", BOT_TOKEN: "IRIS_ISOLATED_DEMO_NOT_A_REAL_BOT_TOKEN",
    MINI_APP_URL: "", PORT: process.env.MINI_API_PORT ?? process.env.PORT ?? "3001",
  });
  const logger = createLogger(config);
  const db = createDatabase("", 10, logger, "development", resolve(".pglite", "mini-app-demo"));
  try {
    await db.init!();
    await seedMiniDemo(db.prisma);
  } catch (error) { await db.close(); throw error; }
  const server = createMiniAppServer({ config, logger, prisma: () => db.prisma, isReady: () => true, botUsername: () => null, demoMode: true });
  await listenMiniApp(server, config.port!);
  logger.info({ port: config.port, mode: "isolated-demo" }, "Iris Mini App preview ready");
  let stopping = false;
  const stop = async () => {
    if (stopping) return; stopping = true;
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await db.close();
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Mini App could not start"); process.exitCode = 1; });
