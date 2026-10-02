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
import type { AppConfig } from "../config/env.js";

const INIT_MIGRATION_PATH = fileURLToPath(
  new URL("../../prisma/migrations/20260930000000_init/migration.sql", import.meta.url),
);

const PURCHASE_BATCH_MIGRATION_PATH = fileURLToPath(
  new URL("../../prisma/migrations/20261002000000_purchase_batches/migration.sql", import.meta.url),
);

const WISHLIST_MIGRATION_PATH = fileURLToPath(
  new URL("../../prisma/migrations/20261002010000_mini_app_wishlist/migration.sql", import.meta.url),
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
): PoolConfig {
  const url = new URL(databaseUrl);
  const sslMode = url.searchParams.get("sslmode")?.toLowerCase();
  const hostname = url.hostname.toLowerCase();

  let ssl: PoolConfig["ssl"] | undefined;
  if (sslMode === "disable") {
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

async function createEmbeddedPGliteHandle(
  logger: AppLogger,
  environment: AppConfig["nodeEnv"],
  embeddedDataDir?: string,
): Promise<{
  prisma: PrismaClient;
  close: () => Promise<void>;
}> {
  if (environment === "production") {
    throw new Error("Embedded storage is not allowed in production. Configure DATABASE_URL.");
  }

  let pg: PGlite;
  if (environment === "test") {
    pg = new PGlite();
    await pg.waitReady;
  } else {
    const dataDir = embeddedDataDir ?? path.resolve(process.cwd(), ".pglite", "iris");
    let persistentPg: PGlite | undefined;
    try {
      await mkdir(path.dirname(dataDir), { recursive: true });
      persistentPg = new PGlite(dataDir);
      await persistentPg.waitReady;
      pg = persistentPg;
      logger.info({ dataDir }, "Initialized persistent development PGlite database");
    } catch (error) {
      await persistentPg?.close().catch(() => undefined);
      throw new Error(
        "Could not initialize persistent development storage. Refusing to use an in-memory database.",
        { cause: error },
      );
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
      try {
        await prisma.$disconnect();
      } finally {
        if (!pg.closed) await pg.close();
      }
    },
  };
}

export async function ensureDatabaseSchema(
  prisma: PrismaClient,
  logger: AppLogger,
  environment: AppConfig["nodeEnv"] = "production",
): Promise<void> {
  if (environment === "production") {
    // Production schema changes belong in the deployment step, never in bot startup.
    try {
      await prisma.$queryRaw`SELECT batch_id, batch_index FROM purchases LIMIT 0`;
      await prisma.$queryRaw`SELECT id FROM wishlist_items LIMIT 0`;
    } catch (error) {
      throw new Error("Database schema is not ready. Run npm run db:deploy before starting Iris.", { cause: error });
    }
    return;
  }

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
  }

  // Ensure any new v2 columns/tables exist on an already-initialized database
  const upgradeStatements = [
    `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "plan_details" VARCHAR(500) NOT NULL DEFAULT ''`,
    `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "delivery_instructions" VARCHAR(2000) NOT NULL DEFAULT ''`,
    `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "warranty_hours" INTEGER NOT NULL DEFAULT 24`,
    `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "media_file_id" VARCHAR(512)`,
    `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "image_url" VARCHAR(1024)`,
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
    `ALTER TYPE "CreditTransactionType" ADD VALUE IF NOT EXISTS 'REFERRAL'`,
    `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "referred_by_id" TEXT`,
    `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "referred_at" TIMESTAMPTZ(6)`,
    `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "referral_reward_credits" INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "referral_welcome_credits" INTEGER NOT NULL DEFAULT 0`,
    `CREATE INDEX IF NOT EXISTS "users_referred_by_id_referred_at_idx" ON "users"("referred_by_id", "referred_at")`,
    `DO $$ BEGIN ALTER TABLE "users" ADD CONSTRAINT "users_referred_by_id_fkey" FOREIGN KEY ("referred_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  ];
  for (const statement of upgradeStatements) {
    // These statements are already idempotent. Any other error must stop startup.
    await prisma.$executeRawUnsafe(statement);
  }

  const batchColumns = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*) AS count
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'purchases'
      AND column_name IN ('batch_id', 'batch_index')
  `;
  if (Number(batchColumns[0]?.count) !== 2) {
    const sql = await readFile(PURCHASE_BATCH_MIGRATION_PATH, "utf8");
    const statements = sql.split(";").map((statement) => statement.trim())
      .filter((statement) => statement && statement !== "BEGIN" && statement !== "COMMIT");
    await prisma.$transaction(async (tx) => {
      for (const statement of statements) await tx.$executeRawUnsafe(statement);
    }, { maxWait: 5_000, timeout: 15_000 });
    logger.info("Purchase batch migration applied to development/test database");
  }
  const wishlist = await prisma.$queryRaw<Array<{ reg: string | null }>>`
    SELECT to_regclass('public.wishlist_items')::text AS reg
  `;
  if (!wishlist[0]?.reg) {
    const sql = await readFile(WISHLIST_MIGRATION_PATH, "utf8");
    const statements = sql.split(";").map((statement) => statement.trim())
      .filter((statement) => statement && statement !== "BEGIN" && statement !== "COMMIT");
    await prisma.$transaction(async (tx) => {
      for (const statement of statements) await tx.$executeRawUnsafe(statement);
    }, { maxWait: 5_000, timeout: 15_000 });
    logger.info("Wishlist migration applied to development/test database");
  }
}

function createPgPoolHandle(
  databaseUrl: string,
  poolSize: number,
  logger: AppLogger,
): { prisma: PrismaClient; close: () => Promise<void> } {
  const pool = new Pool(buildPoolConfig(databaseUrl, poolSize));
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
      try {
        await prisma.$disconnect();
      } finally {
        await pool.end();
      }
    },
  };
}

export function createDatabase(
  databaseUrl: string,
  poolSize: number,
  logger: AppLogger,
  environment: AppConfig["nodeEnv"] = "production",
  embeddedDataDir?: string,
): DatabaseHandle {
  databaseUrl = databaseUrl.trim();
  if (environment === "production" && !databaseUrl) {
    throw new Error("DATABASE_URL is required in production. Embedded or in-memory storage is not allowed.");
  }

  let activeHandle: { prisma: PrismaClient; close: () => Promise<void> } | null = null;
  let initialized = false;
  let initialization: Promise<void> | null = null;
  let lifecycleVersion = 0;

  const handle: DatabaseHandle = {
    get prisma(): PrismaClient {
      if (!activeHandle || !initialized) {
        throw new Error("Database has not been initialized yet");
      }
      return activeHandle.prisma;
    },
    async init() {
      if (initialized) return;
      if (initialization) return initialization;
      initialization = (async () => {
        const openingVersion = lifecycleVersion;
        try {
          if (!databaseUrl) logger.warn("DATABASE_URL is not set; using development/test PGlite storage");
          const openingHandle = databaseUrl
            ? createPgPoolHandle(databaseUrl, poolSize, logger)
            : await createEmbeddedPGliteHandle(logger, environment, embeddedDataDir);
          if (openingVersion !== lifecycleVersion) {
            await openingHandle.close();
            throw new Error("Database initialization was cancelled");
          }
          activeHandle = openingHandle;
          await openingHandle.prisma.$connect();
          await openingHandle.prisma.$queryRaw`SELECT 1`;
          await ensureDatabaseSchema(openingHandle.prisma, logger, environment);
          if (activeHandle !== openingHandle) throw new Error("Database initialization was cancelled");
          initialized = true;
        } catch (error) {
          // Never switch databases (or silently disable SSL) after a configured connection fails.
          await handle.close().catch((closeError: unknown) => {
            logger.warn({ err: closeError }, "Could not close database after initialization failed");
          });
          throw error;
        }
      })();
      try {
        await initialization;
      } finally {
        initialization = null;
      }
    },
    async close() {
      lifecycleVersion += 1;
      const closingHandle = activeHandle;
      activeHandle = null;
      initialized = false;
      if (closingHandle) await closingHandle.close();
    },
  };

  return handle;
}
