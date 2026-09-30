import { spawnSync } from "node:child_process";
import console from "node:console";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runPrismaGenerate } from "./db-generate.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distIndex = path.join(rootDir, "dist", "index.js");
const buildStamp = path.join(rootDir, "dist", ".build-stamp");

const isCloudRuntime = Boolean(
  process.env.RENDER ||
    process.env.RENDER_SERVICE_ID ||
    process.env.RENDER_INSTANCE_ID ||
    process.env.KOYEB_SERVICE_ID ||
    process.env.RAILWAY_ENVIRONMENT ||
    process.env.FLY_APP_NAME ||
    process.env.DYNO ||
    process.env.PORT,
);

// If the deployment platform's Start Command was configured as `npm run build`
// (or `npm install && npm run build`), the build artifacts and `.build-stamp`
// created during the image build phase already exist on disk when the runtime
// container boots. Launch the compiled bot instead of recompiling and exiting.
if (isCloudRuntime && existsSync(buildStamp) && existsSync(distIndex)) {
  console.log("Compiled build found in dist/; starting Iris bot runtime...");
  await import(pathToFileURL(distIndex).href);
} else {
  runPrismaGenerate();

  const tscBin = path.join(
    rootDir,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "tsc.cmd" : "tsc",
  );
  const cmd = existsSync(tscBin) ? tscBin : "npx";
  const args = existsSync(tscBin)
    ? ["-p", "tsconfig.json"]
    : ["tsc", "-p", "tsconfig.json"];

  const result = spawnSync(cmd, args, {
    cwd: rootDir,
    env: process.env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  mkdirSync(path.dirname(buildStamp), { recursive: true });
  writeFileSync(
    buildStamp,
    JSON.stringify({
      commit: process.env.RENDER_GIT_COMMIT ?? "local",
      builtAt: new Date().toISOString(),
    }),
    "utf8",
  );
}
