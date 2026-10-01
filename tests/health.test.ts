import { describe, expect, it } from "vitest";
import { closeHealthServer, startHealthServer } from "../src/http/health.js";

describe("health-check readiness", () => {
  it("returns 503 until startup is ready and again when polling stops", async () => {
    let ready = false;
    const server = await startHealthServer(0, () => ready);
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Health server did not bind a port");
      const url = `http://127.0.0.1:${address.port}`;
      let response = await fetch(url);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ status: "not_ready", service: "iris-credit-store-bot" });
      response = await fetch(url, { method: "HEAD" });
      expect(response.status).toBe(503);
      expect(await response.text()).toBe("");

      ready = true;
      response = await fetch(url);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "ok", service: "iris-credit-store-bot" });
      response = await fetch(url, { method: "POST" });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not_found" });

      ready = false;
      response = await fetch(url);
      expect(response.status).toBe(503);
      await response.text();
    } finally {
      await closeHealthServer(server);
    }
    await closeHealthServer(null);
  });
});
