import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const prismaBin = path.join(
  rootDir,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "prisma.cmd" : "prisma",
);

export function runPrismaGenerate() {
  const cmd = existsSync(prismaBin) ? prismaBin : "npx";
  const args = existsSync(prismaBin) ? ["generate"] : ["prisma", "generate"];

  const envWithLocalBinary = {
    ...process.env,
    PRISMA_SCHEMA_ENGINE_BINARY:
      process.env.PRISMA_SCHEMA_ENGINE_BINARY || process.execPath,
  };

  const result = spawnSync(cmd, args, {
    cwd: rootDir,
    env: envWithLocalBinary,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runPrismaGenerate();
}
