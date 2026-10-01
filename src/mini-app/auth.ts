import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

const telegramUserSchema = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  first_name: z.string().max(128),
  last_name: z.string().max(128).optional(),
  username: z.string().max(64).optional(),
  is_bot: z.boolean().optional(),
  photo_url: z.string().max(2048).optional(),
});

export type VerifiedTelegramUser = z.infer<typeof telegramUserSchema>;

function equalBuffers(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

export function safePhotoUrl(value?: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const allowed = url.hostname === "t.me" || url.hostname.endsWith(".telegram.org") ||
      url.hostname.endsWith(".telegram-cdn.org");
    return allowed && url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

/** Only signed initData is trusted. initDataUnsafe and request-supplied user IDs are never identities. */
export function verifyTelegramInitData(initData: string, botToken: string, now = Date.now()) {
  const invalid = () => new ApiError(401, "TELEGRAM_AUTH", "Open Iris from Telegram to verify your account.");
  if (!initData || initData.length > 16_384) throw invalid();
  const params = new URLSearchParams(initData);
  const names = [...params.keys()];
  if (new Set(names).size !== names.length) throw invalid();
  const hash = params.get("hash");
  if (!hash || !/^[a-f0-9]{64}$/i.test(hash)) throw invalid();
  const dataCheckString = [...params.entries()].filter(([key]) => key !== "hash")
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = createHmac("sha256", secret).update(dataCheckString).digest();
  if (!equalBuffers(Buffer.from(hash, "hex"), expected)) throw invalid();
  const authDate = params.get("auth_date");
  if (!authDate || !/^\d{1,12}$/.test(authDate)) throw invalid();
  const age = Math.floor(now / 1000) - Number(authDate);
  if (!Number.isSafeInteger(age) || age < -30 || age > 3600) {
    throw new ApiError(401, "AUTH_EXPIRED", "Your Telegram session expired. Close and reopen the Mini App.");
  }
  let rawUser: unknown;
  try { rawUser = JSON.parse(params.get("user") ?? ""); } catch { throw invalid(); }
  const parsed = telegramUserSchema.safeParse(rawUser);
  if (!parsed.success || parsed.data.is_bot) throw invalid();
  return { user: parsed.data, startParam: params.get("start_param") ?? "" };
}

const sessionSchema = z.object({
  telegramId: z.string().regex(/^[1-9]\d{0,15}$/),
  exp: z.number().int().positive(),
  photoUrl: z.string().nullable(),
  nonce: z.string(),
}).strict();
export type MiniSession = z.infer<typeof sessionSchema>;

function sessionKey(botToken: string): Buffer {
  return createHmac("sha256", botToken).update("iris-mini-app-session-v1").digest();
}

export function createMiniSession(botToken: string, telegramId: number | bigint, photoUrl: string | null = null, now = Date.now()) {
  const session: MiniSession = {
    telegramId: telegramId.toString(),
    exp: Math.floor(now / 1000) + 3600,
    photoUrl: safePhotoUrl(photoUrl ?? undefined),
    nonce: randomBytes(12).toString("base64url"),
  };
  const payload = Buffer.from(JSON.stringify(session)).toString("base64url");
  const signature = createHmac("sha256", sessionKey(botToken)).update(payload).digest("base64url");
  return { token: `${payload}.${signature}`, expiresAt: new Date(session.exp * 1000).toISOString() };
}

export function verifyMiniSession(token: string | undefined, botToken: string, now = Date.now()): MiniSession {
  const invalid = () => new ApiError(401, "SESSION_EXPIRED", "Your session expired. Please sign in through Telegram again.");
  if (!token || token.length > 5000) throw invalid();
  const parts = token.split(".");
  const payload = parts[0];
  const signature = parts[1];
  if (parts.length !== 2 || !payload || !signature || !/^[a-zA-Z0-9_-]+$/.test(payload) || !/^[a-zA-Z0-9_-]{43}$/.test(signature)) throw invalid();
  const expected = createHmac("sha256", sessionKey(botToken)).update(payload).digest();
  if (!equalBuffers(Buffer.from(signature, "base64url"), expected)) throw invalid();
  let parsed: ReturnType<typeof sessionSchema.safeParse>;
  try { parsed = sessionSchema.safeParse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))); } catch { throw invalid(); }
  if (!parsed.success || parsed.data.exp <= Math.floor(now / 1000)) throw invalid();
  return parsed.data;
}
