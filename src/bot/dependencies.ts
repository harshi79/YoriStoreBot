import type { AppConfig } from "../config/env.js";
import type { DatabaseHandle } from "../db/client.js";
import type { AppLogger } from "../utils/logger.js";

export interface BotDependencies {
  config: AppConfig;
  database: DatabaseHandle;
  logger: AppLogger;
}
