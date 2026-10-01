import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as FsPromises from "node:fs/promises";
import type { AppLogger } from "../src/utils/logger.js";

const mocks = vi.hoisted(() => {
  const prisma = {
    $on: vi.fn(),
    $connect: vi.fn(),
    $disconnect: vi.fn(),
    $queryRaw: vi.fn(),
    $executeRawUnsafe: vi.fn(),
    $transaction: vi.fn(),
  };
  const pool = { on: vi.fn(), end: vi.fn() };
  const pg = { waitReady: Promise.resolve(), closed: false, close: vi.fn() };
  return {
    prisma, pool, pg,
    mkdir: vi.fn(),
    Pool: vi.fn(function (_config: unknown) { return pool; }),
    PGlite: vi.fn(function (_dataDir?: string) { return pg; }),
    PrismaClient: vi.fn(function () { return prisma; }),
    PrismaPg: vi.fn(function () { return {}; }),
    PrismaPGlite: vi.fn(function () { return {}; }),
  };
});

vi.mock("pg", () => ({ Pool: mocks.Pool }));
vi.mock("@electric-sql/pglite", () => ({ PGlite: mocks.PGlite }));
vi.mock("@prisma/adapter-pg", () => ({ PrismaPg: mocks.PrismaPg }));
vi.mock("pglite-prisma-adapter", () => ({ PrismaPGlite: mocks.PrismaPGlite }));
vi.mock("../src/generated/prisma/client.js", () => ({ PrismaClient: mocks.PrismaClient }));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...await importOriginal<typeof FsPromises>(),
  mkdir: mocks.mkdir,
}));

import { createDatabase } from "../src/db/client.js";

const logger = {
  trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(),
} as unknown as AppLogger;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.$connect.mockReset().mockResolvedValue(undefined);
  mocks.prisma.$disconnect.mockReset().mockResolvedValue(undefined);
  mocks.prisma.$queryRaw.mockReset().mockResolvedValue([]);
  mocks.prisma.$executeRawUnsafe.mockReset().mockResolvedValue(0);
  mocks.prisma.$transaction.mockReset();
  mocks.pool.end.mockReset().mockResolvedValue(undefined);
  mocks.pg.close.mockReset().mockResolvedValue(undefined);
  mocks.pg.waitReady = Promise.resolve();
  mocks.pg.closed = false;
  mocks.mkdir.mockReset().mockResolvedValue(undefined);
});

function mockExistingLocalSchema() {
  mocks.prisma.$queryRaw
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ reg: "reset_challenges" }])
    .mockResolvedValueOnce([{ count: 2n }])
    .mockResolvedValueOnce([{ reg: "wishlist_items" }]);
}

describe("fail-safe database initialization", () => {
  it("requires PostgreSQL in production and defaults the factory to production safety", () => {
    expect(() => createDatabase("", 5, logger)).toThrow("DATABASE_URL is required in production");
    expect(() => createDatabase("  ", 5, logger, "production")).toThrow("DATABASE_URL is required in production");
    expect(mocks.Pool).not.toHaveBeenCalled();
    expect(mocks.PGlite).not.toHaveBeenCalled();
  });

  it.each(["production", "development", "test"] as const)(
    "never switches a configured PostgreSQL store on connection failure (%s)", async (environment) => {
      const failure = new Error("ECONNREFUSED: configured PostgreSQL is unavailable");
      mocks.prisma.$connect.mockRejectedValueOnce(failure);
      const database = createDatabase("postgresql://localhost:5432/iris", 5, logger, environment);
      await expect(database.init!()).rejects.toBe(failure);
      expect(mocks.Pool).toHaveBeenCalledTimes(1);
      expect(mocks.PGlite).not.toHaveBeenCalled();
      expect(mocks.prisma.$disconnect).toHaveBeenCalledTimes(1);
      expect(mocks.pool.end).toHaveBeenCalledTimes(1);
      expect(() => database.prisma).toThrow("Database has not been initialized");
      await database.close();
      expect(mocks.pool.end).toHaveBeenCalledTimes(1);
    },
  );

  it("does not silently downgrade a required SSL connection", async () => {
    const failure = new Error("The server does not support SSL connections");
    mocks.prisma.$queryRaw.mockRejectedValueOnce(failure);
    const database = createDatabase("postgresql://db.example.test:5432/iris?sslmode=require", 5, logger, "production");
    await expect(database.init!()).rejects.toBe(failure);
    expect(mocks.Pool).toHaveBeenCalledTimes(1);
    expect(mocks.PGlite).not.toHaveBeenCalled();
    expect(mocks.pool.end).toHaveBeenCalledTimes(1);
  });

  it("checks the deployed production schema without changing it", async () => {
    const database = createDatabase("postgresql://db.example.test:5432/iris", 5, logger, "production");
    expect(() => database.prisma).toThrow("Database has not been initialized");
    await database.init!();
    expect(database.prisma).toBe(mocks.prisma);
    expect(mocks.prisma.$queryRaw).toHaveBeenCalledTimes(3);
    expect(mocks.prisma.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
    expect(mocks.PGlite).not.toHaveBeenCalled();
    await database.init!();
    expect(mocks.Pool).toHaveBeenCalledTimes(1);
    await database.close();
    expect(mocks.pool.end).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent initialization calls into one connection pool", async () => {
    let releaseConnect: (() => void) | undefined;
    mocks.prisma.$connect.mockImplementationOnce(() => new Promise<void>((resolve) => { releaseConnect = resolve; }));
    const database = createDatabase("postgresql://db.example.test:5432/iris", 5, logger, "production");
    const first = database.init!();
    const second = database.init!();
    expect(mocks.Pool).toHaveBeenCalledTimes(1);
    releaseConnect!();
    await Promise.all([first, second]);
    expect(mocks.prisma.$queryRaw).toHaveBeenCalledTimes(3);
    expect(database.prisma).toBe(mocks.prisma);
    await database.close();
    expect(mocks.pool.end).toHaveBeenCalledTimes(1);
  });

  it("permits an explicit retry after failed initialization without switching stores", async () => {
    mocks.prisma.$connect.mockRejectedValueOnce(new Error("temporary connection failure"));
    const database = createDatabase("postgresql://db.example.test:5432/iris", 5, logger, "production");
    await expect(database.init!()).rejects.toThrow("temporary connection failure");
    await database.init!();
    expect(database.prisma).toBe(mocks.prisma);
    expect(mocks.Pool).toHaveBeenCalledTimes(2);
    expect(mocks.PGlite).not.toHaveBeenCalled();
    await database.close();
    expect(mocks.pool.end).toHaveBeenCalledTimes(2);
  });

  it("fails and closes the pool when production migrations are missing", async () => {
    const failure = new Error('column "batch_id" does not exist');
    mocks.prisma.$queryRaw.mockResolvedValueOnce([]).mockRejectedValueOnce(failure);
    const database = createDatabase("postgresql://db.example.test:5432/iris", 5, logger, "production");
    await expect(database.init!()).rejects.toMatchObject({
      message: "Database schema is not ready. Run npm run db:deploy before starting Iris.",
      cause: failure,
    });
    expect(mocks.prisma.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(mocks.pool.end).toHaveBeenCalledTimes(1);
    expect(() => database.prisma).toThrow("Database has not been initialized");
  });

  it("allows in-memory storage only when the caller explicitly selects test mode", async () => {
    mockExistingLocalSchema();
    const database = createDatabase("", 5, logger, "test");
    await database.init!();
    expect(mocks.PGlite).toHaveBeenCalledExactlyOnceWith();
    expect(mocks.Pool).not.toHaveBeenCalled();
    await database.close();
    expect(mocks.pg.close).toHaveBeenCalledTimes(1);
  });

  it("uses a disk-backed database for explicit local development", async () => {
    mockExistingLocalSchema();
    const database = createDatabase("", 5, logger, "development");
    await database.init!();
    expect(mocks.PGlite).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/\.pglite[/\\]iris$/));
    expect(mocks.Pool).not.toHaveBeenCalled();
    await database.close();
  });

  it.each(["directory", "database"])(
    "never falls back to memory when development persistence fails (%s)", async (stage) => {
      if (stage === "directory") {
        mocks.mkdir.mockRejectedValueOnce(new Error("read-only filesystem"));
      } else {
        mocks.PGlite.mockImplementationOnce(function () {
          return { ...mocks.pg, waitReady: Promise.reject(new Error("persistent database could not start")) };
        });
      }
      const database = createDatabase("", 5, logger, "development");
      await expect(database.init!()).rejects.toThrow("Refusing to use an in-memory database");
      expect(mocks.PGlite).toHaveBeenCalledTimes(stage === "directory" ? 0 : 1);
      expect(mocks.PGlite.mock.calls.every((args) => args.length === 1)).toBe(true);
      expect(() => database.prisma).toThrow("Database has not been initialized");
      if (stage === "database") expect(mocks.pg.close).toHaveBeenCalledTimes(1);
    },
  );

  it("does not reopen embedded storage when shutdown happens during initialization", async () => {
    let finishOpening: (() => void) | undefined;
    mocks.pg.waitReady = new Promise<void>((resolve) => { finishOpening = resolve; });
    const database = createDatabase("", 5, logger, "development");
    const initializing = database.init!();
    await Promise.resolve();
    await database.close();
    finishOpening!();
    await expect(initializing).rejects.toThrow("Database initialization was cancelled");
    expect(mocks.pg.close).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.$connect).not.toHaveBeenCalled();
    expect(() => database.prisma).toThrow("Database has not been initialized");
  });

  it("surfaces local schema errors instead of ignoring them and serving an incomplete store", async () => {
    mockExistingLocalSchema();
    const failure = new Error("permission denied for schema upgrade");
    mocks.prisma.$executeRawUnsafe.mockRejectedValueOnce(failure);
    const database = createDatabase("", 5, logger, "test");
    await expect(database.init!()).rejects.toBe(failure);
    expect(mocks.pg.close).toHaveBeenCalledTimes(1);
    expect(() => database.prisma).toThrow("Database has not been initialized");
  });

  it("still closes the PostgreSQL pool if disconnect cleanup also fails", async () => {
    const failure = new Error("PostgreSQL connection failed");
    mocks.prisma.$connect.mockRejectedValueOnce(failure);
    mocks.prisma.$disconnect.mockRejectedValueOnce(new Error("disconnect also failed"));
    const database = createDatabase("postgresql://localhost:5432/iris", 5, logger, "production");
    await expect(database.init!()).rejects.toBe(failure);
    expect(mocks.pool.end).toHaveBeenCalledTimes(1);
    expect(() => database.prisma).toThrow("Database has not been initialized");
  });
});
