import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { PrismaClient } from "../generated/prisma/client.js";
import type { AppLogger } from "../utils/logger.js";

export interface DatabaseHandle {
  prisma: PrismaClient;
  close: () => Promise<void>;
}

export function createDatabase(
  databaseUrl: string,
  poolSize: number,
  logger: AppLogger,
): DatabaseHandle {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: poolSize,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 15_000,
    application_name: "iris-store-bot",
  });
  pool.on("error", (error) => logger.error({ err: error }, "Idle PostgreSQL connection error"));

  const prisma = new PrismaClient({
    adapter: new PrismaPg(pool),
    log: [
      { emit: "event", level: "error" },
      { emit: "event", level: "warn" },
    ],
  });
  prisma.$on("error", (event) => logger.error({ message: event.message }, "Prisma error"));
  prisma.$on("warn", (event) => logger.warn({ message: event.message }, "Prisma warning"));

  return {
    prisma,
    async close() {
      await prisma.$disconnect();
      await pool.end();
    },
  };
}
