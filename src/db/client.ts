import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import type { PoolConfig } from "pg";
import { PrismaPGlite } from "pglite-prisma-adapter";
import { PrismaClient } from "../generated/prisma/client.js";
import type { AppLogger } from "../utils/logger.js";

const INIT_MIGRATION_PATH = fileURLToPath(
  new URL("../../prisma/migrations/20260930000000_init/migration.sql", import.meta.url),
);

const MANAGED_SSL_HOST_SUFFIXES = [
  ".render.com",
  ".neon.tech",
  ".supabase.co",
  ".supabase.com",
  ".railway.app",
  ".aivencloud.com",
];

export interface DatabaseHandle {
  prisma: PrismaClient;
  init?: () => Promise<void>;
  close: () => Promise<void>;
}

function buildPoolConfig(
  databaseUrl: string,
  poolSize: number,
  forceDisableSsl = false,
): PoolConfig {
  const url = new URL(databaseUrl);
  const sslMode = url.searchParams.get("sslmode")?.toLowerCase();
  const hostname = url.hostname.toLowerCase();

  let ssl: PoolConfig["ssl"] | undefined;
  if (forceDisableSsl || sslMode === "disable") {
    url.searchParams.delete("sslmode");
    url.searchParams.delete("uselibpqcompat");
    ssl = false;
  } else if (sslMode === "require" || sslMode === "prefer" || sslMode === "no-verify") {
    if (!url.searchParams.has("uselibpqcompat")) {
      url.searchParams.set("uselibpqcompat", "true");
    }
  } else if (
    !sslMode &&
    MANAGED_SSL_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
  ) {
    ssl = { rejectUnauthorized: false };
  }

  return {
    connectionString: url.toString(),
    max: poolSize,
    connectionTimeoutMillis: 20_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 15_000,
    application_name: "iris-store-bot",
    ...(ssl !== undefined ? { ssl } : {}),
  };
}

function isLocalhostUrl(databaseUrl: string): boolean {
  try {
    const hostname = new URL(databaseUrl).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

async function createEmbeddedPGliteHandle(logger: AppLogger): Promise<{
  prisma: PrismaClient;
  close: () => Promise<void>;
}> {
  let pg: PGlite;
  if (process.env.NODE_ENV === "test") {
    pg = new PGlite();
    await pg.waitReady;
  } else {
    const dataDir = path.resolve(process.cwd(), ".pglite", "iris");
    try {
      await mkdir(path.dirname(dataDir), { recursive: true });
      pg = new PGlite(dataDir);
      await pg.waitReady;
      logger.info({ dataDir }, "Initialized persistent embedded PGlite database");
    } catch (error) {
      logger.warn({ err: error }, "Falling back to in-memory PGlite database");
      pg = new PGlite();
      await pg.waitReady;
    }
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPGlite(pg),
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
      if (!pg.closed) {
        await pg.close();
      }
    },
  };
}

export async function ensureDatabaseSchema(
  prisma: PrismaClient,
  logger: AppLogger,
): Promise<void> {
  const existing = await prisma.$queryRaw<Array<{ reg: string | null }>>`
    SELECT to_regclass('public.reset_challenges')::text AS reg
  `;
  if (!existing[0]?.reg) {
    logger.info("Database tables not found; applying initial schema migration");
    const sql = await readFile(INIT_MIGRATION_PATH, "utf8");
    const statements = sql
      .split(";")
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);

    for (const statement of statements) {
      try {
        await prisma.$executeRawUnsafe(statement);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (
          message.includes("already exists") ||
          message.includes("42710") ||
          message.includes("42P07")
        ) {
          continue;
        }
        throw error;
      }
    }
    logger.info("Initial database schema migration applied");
    return;
  }

  // Ensure any new v2 columns/tables exist on an already-initialized database
  const upgradeStatements = [
    `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "plan_details" VARCHAR(500) NOT NULL DEFAULT ''`,
    `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "delivery_instructions" VARCHAR(2000) NOT NULL DEFAULT ''`,
    `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "warranty_hours" INTEGER NOT NULL DEFAULT 24`,
    `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "media_file_id" VARCHAR(512)`,
    `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "featured" BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "is_unlimited" BOOLEAN NOT NULL DEFAULT false`,
    `DO $$ BEGIN CREATE TYPE "WarrantyClaimStatus" AS ENUM ('PENDING', 'REPLACED', 'REFUNDED', 'REJECTED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
    `CREATE TABLE IF NOT EXISTS "stock_subscriptions" ("id" TEXT NOT NULL, "user_id" TEXT NOT NULL, "product_id" TEXT NOT NULL, "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "stock_subscriptions_pkey" PRIMARY KEY ("id"))`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "stock_subscriptions_user_id_product_id_key" ON "stock_subscriptions"("user_id", "product_id")`,
    `CREATE INDEX IF NOT EXISTS "stock_subscriptions_product_id_created_at_idx" ON "stock_subscriptions"("product_id", "created_at")`,
    `CREATE TABLE IF NOT EXISTS "warranty_claims" ("id" TEXT NOT NULL, "purchase_id" TEXT NOT NULL, "buyer_id" TEXT NOT NULL, "product_id" TEXT NOT NULL, "reason" VARCHAR(500) NOT NULL, "status" "WarrantyClaimStatus" NOT NULL DEFAULT 'PENDING', "resolution_note" VARCHAR(500), "replacement_item_id" TEXT, "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "resolved_at" TIMESTAMPTZ(6), CONSTRAINT "warranty_claims_pkey" PRIMARY KEY ("id"))`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "warranty_claims_purchase_id_key" ON "warranty_claims"("purchase_id")`,
    `CREATE INDEX IF NOT EXISTS "warranty_claims_status_created_at_idx" ON "warranty_claims"("status", "created_at")`,
    `CREATE INDEX IF NOT EXISTS "warranty_claims_buyer_id_created_at_idx" ON "warranty_claims"("buyer_id", "created_at")`,
  ];
  for (const statement of upgradeStatements) {
    try {
      await prisma.$executeRawUnsafe(statement);
    } catch {
      // Ignore if already applied
    }
  }
}

function createPgPoolHandle(
  databaseUrl: string,
  poolSize: number,
  logger: AppLogger,
  forceDisableSsl = false,
): { prisma: PrismaClient; close: () => Promise<void> } {
  const pool = new Pool(buildPoolConfig(databaseUrl, poolSize, forceDisableSsl));
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

export function createDatabase(
  databaseUrl: string,
  poolSize: number,
  logger: AppLogger,
): DatabaseHandle {
  let activeHandle: { prisma: PrismaClient; close: () => Promise<void> } | null =
    databaseUrl ? createPgPoolHandle(databaseUrl, poolSize, logger) : null;

  const handle: DatabaseHandle = {
    get prisma(): PrismaClient {
      if (!activeHandle) {
        throw new Error("Database has not been initialized yet");
      }
      return activeHandle.prisma;
    },
    async init() {
      if (!databaseUrl) {
        logger.warn("DATABASE_URL is not set; using embedded PGlite database");
        activeHandle = await createEmbeddedPGliteHandle(logger);
        await activeHandle.prisma.$connect();
        await ensureDatabaseSchema(activeHandle.prisma, logger);
        return;
      }

      if (!activeHandle) {
        activeHandle = createPgPoolHandle(databaseUrl, poolSize, logger);
      }

      try {
        await activeHandle.prisma.$connect();
        await activeHandle.prisma.$queryRaw`SELECT 1`;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("The server does not support SSL connections")) {
          logger.warn("PostgreSQL server does not support SSL; reconnecting without SSL");
          await activeHandle.close().catch(() => undefined);
          activeHandle = createPgPoolHandle(databaseUrl, poolSize, logger, true);
          await activeHandle.prisma.$connect();
          await activeHandle.prisma.$queryRaw`SELECT 1`;
        } else if (isLocalhostUrl(databaseUrl)) {
          logger.warn(
            { err: error },
            "Local PostgreSQL is unreachable; falling back to embedded PGlite database",
          );
          await activeHandle.close().catch(() => undefined);
          activeHandle = await createEmbeddedPGliteHandle(logger);
          await activeHandle.prisma.$connect();
        } else {
          throw error;
        }
      }

      await ensureDatabaseSchema(activeHandle.prisma, logger);
    },
    async close() {
      if (activeHandle) {
        await activeHandle.close();
      }
    },
  };

  return handle;
}
