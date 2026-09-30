import { z } from "zod";

export const OWNER_TELEGRAM_ID = 7_728_424_218n;

function isPostgresUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "postgres:" || url.protocol === "postgresql:") && /^postgres(?:ql)?:\/\//i.test(value);
  } catch {
    return false;
  }
}

const environmentSchema = z.object({
  BOT_TOKEN: z.string().min(20, "BOT_TOKEN is required"),
  DATABASE_URL: z.string().refine(isPostgresUrl, "DATABASE_URL must be a valid PostgreSQL URL"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  BONUS_CREDITS: z.coerce.number().int().min(1).max(1_000_000).default(25),
  BONUS_PERIOD_HOURS: z.coerce.number().int().min(1).max(720).default(24),
  DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  PM2_APP_NAME: z.string().optional().default(""),
});

export interface AppConfig {
  botToken: string;
  databaseUrl: string;
  ownerId: bigint;
  nodeEnv: "development" | "test" | "production";
  logLevel: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
  bonusCredits: number;
  bonusPeriodHours: number;
  databasePoolSize: number;
  pm2AppName: string;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = environmentSchema.safeParse(source);
  if (!parsed.success) {
    const fields = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid Iris configuration: ${fields}`);
  }
  return {
    botToken: parsed.data.BOT_TOKEN,
    databaseUrl: parsed.data.DATABASE_URL,
    ownerId: OWNER_TELEGRAM_ID,
    nodeEnv: parsed.data.NODE_ENV,
    logLevel: parsed.data.LOG_LEVEL,
    bonusCredits: parsed.data.BONUS_CREDITS,
    bonusPeriodHours: parsed.data.BONUS_PERIOD_HOURS,
    databasePoolSize: parsed.data.DATABASE_POOL_SIZE,
    pm2AppName: parsed.data.PM2_APP_NAME,
  };
}
