import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runPrismaGenerate } from "./db-generate.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
runPrismaGenerate();
for (const [name, args] of [["tsc", ["-p", "tsconfig.json"]], ["tsc", ["-p", "web/tsconfig.json", "--noEmit"]], ["vite", ["build", "--config", "web/vite.config.ts"]]]) {
  const binary = path.join(root, "node_modules", ".bin", process.platform === "win32" ? `${name}.cmd` : name);
  const result = spawnSync(existsSync(binary) ? binary : "npx", existsSync(binary) ? args : [name, ...args], {
    cwd: root, env: process.env, stdio: "inherit", shell: process.platform === "win32",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
