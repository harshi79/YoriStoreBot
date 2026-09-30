import pino from "pino";
import type { AppConfig } from "../config/env.js";

export function createLogger(config: AppConfig) {
  return pino({
    name: "iris-store-bot",
    level: config.logLevel,
    base: {
      service: "iris-store-bot",
      environment: config.nodeEnv,
    },
    redact: {
      paths: ["*.botToken", "*.token", "*.password", "*.payload"],
      censor: "[REDACTED]",
    },
  });
}

export type AppLogger = ReturnType<typeof createLogger>;
