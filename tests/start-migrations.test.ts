import { describe, expect, it, vi } from "vitest";
// @ts-expect-error -- scripts/start.mjs is a plain Node script outside the typed src project.
import {
  applyPendingMigrations,
  isMigrationToolingUnavailable,
  migrationToBaseline,
  readDatabaseUrl,
  shouldSkipMigrations,
} from "../scripts/start.mjs";

interface RunnerCall {
  args: string[];
  databaseUrl: string;
}

/** Builds a runner that returns queued results and records every invocation. */
function fakeRunner(results: Array<{ status: number; output: string }>) {
  const calls: RunnerCall[] = [];
  let index = 0;
  const runner = (_command: string, args: string[], options: { databaseUrl: string }) => {
    calls.push({ args, databaseUrl: options.databaseUrl });
    const result = results[Math.min(index, results.length - 1)];
    index += 1;
    return result ?? { status: 1, output: "no queued result" };
  };
  return { runner, calls };
}

const prisma = { command: "/bin/prisma", args: [] as string[] };
/** A fresh spy per test so warning assertions never see another test's calls. */
const makeLog = () => ({ warn: vi.fn() });
const DATABASE_URL = "postgresql://iris:secret@db.example.com:5432/iris?schema=public";

describe("readDatabaseUrl", () => {
  it("returns a configured PostgreSQL URL", () => {
    expect(readDatabaseUrl({ DATABASE_URL: `  ${DATABASE_URL}  ` })).toBe(DATABASE_URL);
  });

  it("treats a missing or example-placeholder URL as unconfigured", () => {
    expect(readDatabaseUrl({})).toBe("");
    expect(readDatabaseUrl({ DATABASE_URL: "   " })).toBe("");
    expect(readDatabaseUrl({
      DATABASE_URL: "postgresql://YOUR_DB_USER:YOUR_DB_PASSWORD@localhost:5432/iris?schema=public",
    })).toBe("");
  });
});

describe("shouldSkipMigrations", () => {
  it("accepts the documented opt-out values", () => {
    for (const value of ["1", "true", "TRUE", " yes "]) expect(shouldSkipMigrations({ SKIP_DB_MIGRATIONS: value })).toBe(true);
  });

  it("runs migrations unless explicitly disabled", () => {
    expect(shouldSkipMigrations({})).toBe(false);
    expect(shouldSkipMigrations({ SKIP_DB_MIGRATIONS: "0" })).toBe(false);
    expect(shouldSkipMigrations({ SKIP_DB_MIGRATIONS: "false" })).toBe(false);
  });
});

describe("migrationToBaseline", () => {
  it("identifies the migration whose objects already exist", () => {
    const output = [
      "Applying migration `20260930000000_init`",
      'Error: P3006 migration failed to apply cleanly: (code: 42P07) relation "users" already exists',
    ].join("\n");
    expect(migrationToBaseline(output)).toBe("20260930000000_init");
  });

  it("reports the most recent migration when several were applied", () => {
    const output = [
      "Applying migration `20260930000000_init`",
      "Applying migration `20261002000000_purchase_batches`",
      'Error: column "batch_id" of relation "purchases" already exists',
    ].join("\n");
    expect(migrationToBaseline(output)).toBe("20261002000000_purchase_batches");
  });

  it("returns null without a conflict or without a migration name", () => {
    expect(migrationToBaseline("Applying migration `20260930000000_init`\nError: P1001 connection refused")).toBeNull();
    expect(migrationToBaseline('Error: relation "users" already exists')).toBeNull();
    expect(migrationToBaseline("")).toBeNull();
  });
});

describe("applyPendingMigrations", () => {
  it("skips entirely when no PostgreSQL URL is configured", () => {
    const { runner, calls } = fakeRunner([{ status: 0, output: "" }]);
    const result = applyPendingMigrations({ databaseUrl: "", runner, prisma, log: makeLog() });
    expect(result.status).toBe("skipped");
    expect(calls).toEqual([]);
  });

  it("reports unavailable instead of guessing when the Prisma CLI is missing", () => {
    const { runner, calls } = fakeRunner([{ status: 0, output: "" }]);
    const result = applyPendingMigrations({ databaseUrl: DATABASE_URL, runner, prisma: null, log: makeLog() });
    expect(result.status).toBe("unavailable");
    expect(calls).toEqual([]);
  });

  it("deploys committed migrations for an up-to-date or fresh database", () => {
    const { runner, calls } = fakeRunner([{ status: 0, output: "No pending migrations to apply." }]);
    const result = applyPendingMigrations({ databaseUrl: DATABASE_URL, runner, prisma, log: makeLog() });
    expect(result).toMatchObject({ status: "applied", baselined: [] });
    expect(calls).toEqual([{ args: ["migrate", "deploy"], databaseUrl: DATABASE_URL }]);
  });

  it("baselines a history-less database, then applies the remaining migrations", () => {
    const { runner, calls } = fakeRunner([
      { status: 1, output: 'Applying migration `20260930000000_init`\nError: (code: 42P07) relation "users" already exists' },
      { status: 0, output: "Migration 20260930000000_init marked as applied." },
      { status: 0, output: "Applying migration `20261002000000_purchase_batches`\nApplying migration `20261002010000_mini_app_wishlist`" },
    ]);
    const log = makeLog();
    const result = applyPendingMigrations({ databaseUrl: DATABASE_URL, runner, prisma, log });
    expect(result.status).toBe("applied");
    expect(result.baselined).toEqual(["20260930000000_init"]);
    expect(calls.map((call) => call.args)).toEqual([
      ["migrate", "deploy"],
      ["migrate", "resolve", "--applied", "20260930000000_init"],
      ["migrate", "deploy"],
    ]);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("20260930000000_init"));
  });

  it("baselines each already-present migration until deploy converges", () => {
    const { runner, calls } = fakeRunner([
      { status: 1, output: 'Applying migration `20260930000000_init`\nError: relation "users" already exists' },
      { status: 0, output: "marked as applied" },
      { status: 1, output: 'Applying migration `20261002000000_purchase_batches`\nError: column "batch_id" of relation "purchases" already exists' },
      { status: 0, output: "marked as applied" },
      { status: 0, output: "Database schema is up to date!" },
    ]);
    const result = applyPendingMigrations({ databaseUrl: DATABASE_URL, runner, prisma, log: makeLog() });
    expect(result.status).toBe("applied");
    expect(result.baselined).toEqual(["20260930000000_init", "20261002000000_purchase_batches"]);
    expect(calls.filter((call) => call.args[0] === "migrate" && call.args[1] === "deploy")).toHaveLength(3);
  });

  it("stops instead of looping when the same conflict repeats", () => {
    const conflict = { status: 1, output: 'Applying migration `20260930000000_init`\nError: relation "users" already exists' };
    const { runner, calls } = fakeRunner([conflict, { status: 0, output: "marked as applied" }, conflict]);
    const result = applyPendingMigrations({ databaseUrl: DATABASE_URL, runner, prisma, log: makeLog() });
    expect(result.status).toBe("failed");
    expect(result.baselined).toEqual(["20260930000000_init"]);
    expect(calls.filter((call) => call.args[1] === "deploy")).toHaveLength(2);
    expect(calls.filter((call) => call.args[1] === "resolve")).toHaveLength(1);
  });

  it("fails immediately on a non-conflict error without touching migration history", () => {
    const { runner, calls } = fakeRunner([{ status: 1, output: "Error: P1001 Can't reach database server" }]);
    const result = applyPendingMigrations({ databaseUrl: DATABASE_URL, runner, prisma, log: makeLog() });
    expect(result.status).toBe("failed");
    expect(result.baselined).toEqual([]);
    expect(result.output).toContain("P1001");
    expect(calls).toEqual([{ args: ["migrate", "deploy"], databaseUrl: DATABASE_URL }]);
  });

  it("fails when the baseline command itself is rejected", () => {
    const { runner, calls } = fakeRunner([
      { status: 1, output: 'Applying migration `20260930000000_init`\nError: relation "users" already exists' },
      { status: 1, output: "Error: P3005 The database schema is empty" },
    ]);
    const result = applyPendingMigrations({ databaseUrl: DATABASE_URL, runner, prisma, log: makeLog() });
    expect(result.status).toBe("failed");
    expect(result.baselined).toEqual([]);
    expect(result.output).toContain("P3005");
    expect(calls).toHaveLength(2);
  });

  it("respects a CLI that is only reachable through npx", () => {
    const { runner, calls } = fakeRunner([{ status: 0, output: "up to date" }]);
    applyPendingMigrations({
      databaseUrl: DATABASE_URL,
      runner,
      prisma: { command: "/bin/npx", args: ["--no-install", "prisma"] },
      log: makeLog(),
    });
    expect(calls[0]?.args).toEqual(["--no-install", "prisma", "migrate", "deploy"]);
  });

  it("never exceeds the recovery attempt budget", () => {
    // Every deploy conflicts on a brand-new migration, so recovery can never converge.
    const calls: RunnerCall[] = [];
    let deploys = 0;
    const runner = (_command: string, args: string[], options: { databaseUrl: string }) => {
      calls.push({ args, databaseUrl: options.databaseUrl });
      if (args.includes("resolve")) return { status: 0, output: "marked as applied" };
      deploys += 1;
      return {
        status: 1,
        output: `Applying migration \`2026010${deploys}000000_step${deploys}\`\nError: relation "t${deploys}" already exists`,
      };
    };
    const result = applyPendingMigrations({ databaseUrl: DATABASE_URL, runner, prisma, log: makeLog(), maxAttempts: 3 });
    expect(result.status).toBe("failed");
    expect(result.output).toContain("did not converge");
    // Three attempts, each one deploy plus one baseline resolve.
    expect(deploys).toBe(3);
    expect(result.baselined).toHaveLength(3);
    expect(calls).toHaveLength(6);
  });
});

describe("isMigrationToolingUnavailable", () => {
  it("recognises a Prisma engine that could not be loaded or downloaded", () => {
    expect(isMigrationToolingUnavailable(
      "Error: request to https://binaries.prisma.sh/all_commits/abc123/debian-openssl-3.0.x/schema-engine.gz.sha256 failed, reason: Client network socket disconnected",
    )).toBe(true);
    expect(isMigrationToolingUnavailable("Error: Cannot find module '@prisma/engines'")).toBe(true);
    expect(isMigrationToolingUnavailable("spawn /app/node_modules/.bin/prisma ENOENT")).toBe(true);
  });

  it("does not mistake a schema conflict or an unreachable database for missing tooling", () => {
    expect(isMigrationToolingUnavailable(
      'Applying migration `20260930000000_init`\nError: relation "users" already exists',
    )).toBe(false);
    expect(isMigrationToolingUnavailable('Error: P1001 Can\'t reach database server at "db:5432"')).toBe(false);
    expect(isMigrationToolingUnavailable("")).toBe(false);
  });
});

describe("applyPendingMigrations with unusable tooling", () => {
  it("reports unavailable instead of blocking startup when the engine cannot run", () => {
    const { runner, calls } = fakeRunner([
      { status: 1, output: "Error: request to https://binaries.prisma.sh/x/schema-engine.gz.sha256 failed" },
    ]);
    const result = applyPendingMigrations({ databaseUrl: DATABASE_URL, runner, prisma, log: makeLog() });
    expect(result.status).toBe("unavailable");
    expect(result.output).toContain("binaries.prisma.sh");
    expect(calls).toHaveLength(1);
  });

  it("treats a tooling failure during baseline recovery as unavailable", () => {
    const { runner, calls } = fakeRunner([
      { status: 1, output: 'Applying migration `20260930000000_init`\nError: relation "users" already exists' },
      { status: 1, output: "Error: Cannot find module '@prisma/engines'" },
    ]);
    const result = applyPendingMigrations({ databaseUrl: DATABASE_URL, runner, prisma, log: makeLog() });
    expect(result.status).toBe("unavailable");
    expect(result.baselined).toEqual([]);
    expect(calls).toHaveLength(2);
  });
});
