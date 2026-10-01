import { spawn, spawnSync } from "node:child_process";
import console from "node:console";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Mirrors src/config/env.ts: an example placeholder is not a real connection. */
const PLACEHOLDER_DB_FRAGMENT = "YOUR_DB_USER:YOUR_DB_PASSWORD";

/**
 * `prisma migrate deploy` output while it executes a migration. Used only to
 * identify which committed migration hit pre-existing objects.
 */
const APPLYING_MIGRATION = /Applying migration [`"']?([A-Za-z0-9_.-]+)[`"']?/g;

/**
 * PostgreSQL "object already exists" failures. These are the signature of a
 * database whose tables were created without Prisma migration history, which is
 * the documented baseline case — never a reason to force or reset anything.
 */
const BASELINEABLE_CONFLICT =
  /already exists|duplicate_object|duplicate_table|duplicate_column|duplicate_schema|42P06|42P07|42701|42710/i;

/**
 * Failures that mean the migration tooling itself could not run (missing or
 * undownloadable Prisma engine, unwritable cache, broken CLI install) rather than
 * a problem with the schema. These must not block startup: a host whose database
 * is already migrated would otherwise stop booting, so Iris starts and its own
 * production schema check remains the authoritative gate.
 */
const MIGRATION_TOOLING_UNAVAILABLE =
  /binaries\.prisma\.sh|schema-engine|query-engine|Unable to require|Cannot find module|Cannot find package|ENOENT|EACCES|EPERM|ENOTFOUND|EAI_AGAIN/i;

export function readDatabaseUrl(env = process.env) {
  const raw = (env.DATABASE_URL ?? "").trim();
  if (!raw || raw.includes(PLACEHOLDER_DB_FRAGMENT)) return "";
  return raw;
}

export function shouldSkipMigrations(env = process.env) {
  const raw = (env.SKIP_DB_MIGRATIONS ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/** Prefer the locally installed CLI; never download packages during a deploy. */
export function resolvePrismaCommand(root = rootDir) {
  const extension = process.platform === "win32" ? ".cmd" : "";
  const localBinary = path.join(root, "node_modules", ".bin", `prisma${extension}`);
  if (existsSync(localBinary)) return { command: localBinary, args: [] };
  const npx = path.join(root, "node_modules", ".bin", `npx${extension}`);
  if (existsSync(npx)) return { command: npx, args: ["--no-install", "prisma"] };
  return null;
}

/**
 * Returns the migration that should be marked applied, or null when the failure
 * is anything other than a pre-existing-object conflict.
 */
export function migrationToBaseline(output) {
  if (!output || !BASELINEABLE_CONFLICT.test(output)) return null;
  let last = null;
  for (const match of output.matchAll(APPLYING_MIGRATION)) last = match[1] ?? last;
  return last;
}

export function isMigrationToolingUnavailable(output) {
  return Boolean(output) && MIGRATION_TOOLING_UNAVAILABLE.test(output);
}

function defaultRunner(command, args, { root, databaseUrl }) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    shell: process.platform === "win32",
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.error) return { status: 1, output: `${output}${result.error.message}` };
  return { status: result.status ?? 1, output };
}

/**
 * Apply the committed migrations with `prisma migrate deploy`.
 *
 * Hosts that only run the package start command never reach `npm run db:deploy`,
 * which leaves production refusing to boot with "Database schema is not ready".
 * This runs the same official, non-destructive command before the app starts.
 *
 * If a database was created without migration history, deploy stops on the first
 * migration whose objects already exist. That migration is recorded as applied
 * with `prisma migrate resolve --applied` — the recovery the README documents —
 * and deploy is retried. Nothing is ever reset, pushed, or generated here.
 */
export function applyPendingMigrations({
  databaseUrl,
  root = rootDir,
  runner = defaultRunner,
  prisma = resolvePrismaCommand(root),
  log = console,
  maxAttempts = 12,
} = {}) {
  if (!databaseUrl) return { status: "skipped", baselined: [], output: "" };
  if (!prisma) return { status: "unavailable", baselined: [], output: "" };

  const baselined = [];
  let output = "";
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const deploy = runner(prisma.command, [...prisma.args, "migrate", "deploy"], { root, databaseUrl });
    output = deploy.output;
    if (deploy.status === 0) return { status: "applied", baselined, output };

    const migration = migrationToBaseline(deploy.output);
    // Without a conflict, or if we already baselined it, retrying cannot help.
    if (!migration || baselined.includes(migration)) {
      return {
        status: isMigrationToolingUnavailable(deploy.output) ? "unavailable" : "failed",
        baselined,
        output,
      };
    }

    log.warn?.(
      `Migration ${migration} found objects that already exist; recording it as applied so the remaining migrations can run.`,
    );
    const resolved = runner(
      prisma.command,
      [...prisma.args, "migrate", "resolve", "--applied", migration],
      { root, databaseUrl },
    );
    if (resolved.status !== 0) {
      const combined = `${deploy.output}\n${resolved.output}`;
      return {
        status: isMigrationToolingUnavailable(resolved.output) ? "unavailable" : "failed",
        baselined,
        output: combined,
      };
    }
    baselined.push(migration);
  }
  return { status: "failed", baselined, output: `${output}\nMigration recovery did not converge.` };
}

function startApplication() {
  const entry = path.join(rootDir, "dist", "index.js");
  if (!existsSync(entry)) {
    console.error("dist/index.js was not found. Run `npm run build` before `npm start`.");
    process.exit(1);
  }

  const child = spawn(process.execPath, [entry], {
    cwd: rootDir,
    env: process.env,
    stdio: "inherit",
  });

  let shuttingDown = false;
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      child.kill(signal);
    });
  }

  child.on("error", (error) => {
    console.error("Could not start Iris:", error.message);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
}

async function main() {
  // Load .env before reading DATABASE_URL, mirroring the application entry point.
  // Hosts usually inject real environment variables, so a missing dotenv must not
  // stop migrations from running with the environment we already have.
  await import("dotenv/config").catch(() => undefined);
  const databaseUrl = readDatabaseUrl();
  if (!databaseUrl) {
    console.log("DATABASE_URL is not set; skipping migration deploy (embedded storage manages its own schema).");
  } else if (shouldSkipMigrations()) {
    console.log("SKIP_DB_MIGRATIONS is set; skipping `prisma migrate deploy`.");
  } else {
    const result = applyPendingMigrations({ databaseUrl, log: console });
    if (result.status === "applied") {
      console.log(
        result.baselined.length
          ? `Database migrations up to date (recorded as applied: ${result.baselined.join(", ")}).`
          : "Database migrations up to date.",
      );
    } else if (result.status === "unavailable") {
      console.warn(
        "Pending migrations could not be applied because the Prisma migration tooling is unavailable " +
          "(missing CLI, or its engine could not be loaded or downloaded). Starting Iris anyway: its own " +
          "database schema check will still stop it if a migration is genuinely required. " +
          "Run `npm run db:deploy` to apply migrations explicitly.",
      );
      if (result.output.trim()) console.warn(result.output.trim());
    } else {
      console.error("`prisma migrate deploy` did not complete, so Iris is not starting.\n");
      console.error(result.output.trim());
      console.error(
        "\nResolve the migration failure above, then start Iris again. " +
          "To start without running migrations, set SKIP_DB_MIGRATIONS=1.",
      );
      process.exit(1);
    }
  }
  startApplication();
}

if (import.meta.url === `file://${process.argv[1]}`) void main();
