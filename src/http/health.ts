import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AppLogger } from "../utils/logger.js";

export function startHealthServer(
  port: number,
  isReady: () => boolean,
  logger?: AppLogger,
): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (req.method === "GET" || req.method === "HEAD") {
        const ready = isReady();
        res.writeHead(ready ? 200 : 503, { "content-type": "application/json; charset=utf-8" });
        res.end(req.method === "HEAD" ? undefined : JSON.stringify({
          status: ready ? "ok" : "not_ready",
          service: "iris-credit-store-bot",
        }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "not_found" }));
    });
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => {
      server.removeListener("error", reject);
      logger?.info({ port }, "Health check HTTP server listening");
      resolve(server);
    });
  });
}

export function closeHealthServer(server: Server | null): Promise<void> {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}
