import { z } from "zod";

export const OWNER_TELEGRAM_ID = 7_728_424_218n;

const PLACEHOLDER_DB_FRAGMENT = "YOUR_DB_USER:YOUR_DB_PASSWORD";

function isPostgresUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "postgres:" || url.protocol === "postgresql:") && /^postgres(?:ql)?:\/\//i.test(value);
  } catch {
    return false;
  }
}

function cleanOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

const environmentSchema = z.object({
  BOT_TOKEN: z.string().trim().min(20, "BOT_TOKEN is required"),
  DATABASE_URL: z
    .string()
    .trim()
    .optional()
    .default("")
    .refine(
      (value) => value === "" || isPostgresUrl(value),
      "DATABASE_URL must be a valid PostgreSQL URL",
    ),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  BONUS_CREDITS: z.coerce.number().int().min(1).max(1_000_000).default(25),
  BONUS_PERIOD_HOURS: z.coerce.number().int().min(1).max(720).default(24),
  DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  PM2_APP_NAME: z.string().optional().default(""),
  PORT: z.coerce.number().int().min(1).max(65535).optional(),
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
  port?: number | undefined;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const rawBotToken = cleanOptionalString(
    source.BOT_TOKEN ?? source.TELEGRAM_BOT_TOKEN ?? source.TOKEN,
  );
  const rawDatabaseUrl = cleanOptionalString(source.DATABASE_URL);
  const rawNodeEnv = cleanOptionalString(source.NODE_ENV)?.toLowerCase();
  const normalizedNodeEnv =
    rawNodeEnv === "development" || rawNodeEnv === "test" || rawNodeEnv === "production"
      ? rawNodeEnv
      : rawNodeEnv
        ? "production"
        : undefined;
  const rawLogLevel = cleanOptionalString(source.LOG_LEVEL)?.toLowerCase();

  const normalizedSource: Record<string, string | undefined> = {
    BOT_TOKEN: rawBotToken,
    DATABASE_URL:
      rawDatabaseUrl && rawDatabaseUrl.includes(PLACEHOLDER_DB_FRAGMENT)
        ? ""
        : rawDatabaseUrl,
    NODE_ENV: normalizedNodeEnv,
    LOG_LEVEL: rawLogLevel,
    BONUS_CREDITS: cleanOptionalString(source.BONUS_CREDITS),
    BONUS_PERIOD_HOURS: cleanOptionalString(source.BONUS_PERIOD_HOURS),
    DATABASE_POOL_SIZE: cleanOptionalString(source.DATABASE_POOL_SIZE),
    PM2_APP_NAME: cleanOptionalString(source.PM2_APP_NAME),
    PORT: cleanOptionalString(source.PORT),
  };

  const parsed = environmentSchema.safeParse(normalizedSource);
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
    port: parsed.data.PORT,
  };
}
