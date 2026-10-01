import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));

describe("production startup", () => {
  it("exits on missing PostgreSQL configuration even when a health-check PORT is supplied", async () => {
    const portReservation = createServer();
    portReservation.listen(0, "127.0.0.1");
    await once(portReservation, "listening");
    const address = portReservation.address();
    if (!address || typeof address === "string") throw new Error("Could not reserve a test port");
    await new Promise<void>((resolve, reject) => portReservation.close((error) => error ? reject(error) : resolve()));

    await expect(run(process.execPath, ["--import", "tsx", "src/index.ts"], {
      cwd: root,
      timeout: 8_000,
      env: {
        ...process.env,
        NODE_ENV: "production",
        BOT_TOKEN: "TEST_TOKEN_NOT_A_REAL_CREDENTIAL",
        DATABASE_URL: "",
        PORT: String(address.port),
      },
    })).rejects.toMatchObject({
      code: 1,
      killed: false,
      signal: null,
      stderr: expect.stringContaining("DATABASE_URL is required in production"),
    });
  }, 15_000);
});
