import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/env.js";
import { ApiError, createMiniSession, safePhotoUrl, verifyMiniSession, verifyTelegramInitData } from "../src/mini-app/auth.js";

const TOKEN = "TEST_MINI_APP_TOKEN_NOT_A_REAL_CREDENTIAL";
const NOW = Date.UTC(2026, 9, 2, 9, 0);
function signed(params: URLSearchParams, token = TOKEN) {
  const values = [...params.entries()].filter(([key]) => key !== "hash").sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  params.set("hash", createHmac("sha256", secret).update(values.map(([key, value]) => `${key}=${value}`).join("\n")).digest("hex"));
  return params.toString();
}
function fixture() {
  return new URLSearchParams({
    auth_date: String(NOW / 1000), query_id: "query-test", signature: "telegram-extra-signature-field",
    user: JSON.stringify({ id: 10_001, first_name: "Alice <b>", username: "alice_test", photo_url: "https://t.me/i/userpic/320/example.jpg" }),
    start_param: "ref_10002",
  });
}

describe("Telegram Mini App authentication", () => {
  it("verifies the complete Telegram HMAC, including the newer signature parameter", () => {
    const verified = verifyTelegramInitData(signed(fixture()), TOKEN, NOW);
    expect(verified.user).toMatchObject({ id: 10_001, first_name: "Alice <b>", username: "alice_test" });
    expect(verified.startParam).toBe("ref_10002");
  });
  it("rejects forged identities instead of trusting initDataUnsafe or a body user ID", () => {
    const params = new URLSearchParams(signed(fixture()));
    params.set("user", JSON.stringify({ id: 7_728_424_218, first_name: "Owner" }));
    expect(() => verifyTelegramInitData(params.toString(), TOKEN, NOW)).toThrow(ApiError);
  });
  it("rejects signatures generated with another bot token", () => {
    expect(() => verifyTelegramInitData(signed(fixture(), "OTHER_BOT_TOKEN"), TOKEN, NOW)).toThrow(ApiError);
  });
  it("rejects duplicate parameters even when their hash was recomputed", () => {
    const params = fixture(); params.append("user", JSON.stringify({ id: 99, first_name: "Forged" }));
    expect(() => verifyTelegramInitData(signed(params), TOKEN, NOW)).toThrow(ApiError);
  });
  it.each(["", "hash=abc", "auth_date=1&hash=" + "a".repeat(64)])("rejects missing or malformed Telegram data (%s)", (data) => {
    expect(() => verifyTelegramInitData(data, TOKEN, NOW)).toThrow(ApiError);
  });
  it.each([-3601, 31])("rejects expired or future authentication dates (%i)", (offset) => {
    const params = fixture(); params.set("auth_date", String(NOW / 1000 + offset));
    expect(() => verifyTelegramInitData(signed(params), TOKEN, NOW)).toThrow(/expired/);
  });
  it("accepts a small clock skew but still validates the identity", () => {
    const params = fixture(); params.set("auth_date", String(NOW / 1000 + 20));
    expect(verifyTelegramInitData(signed(params), TOKEN, NOW).user.id).toBe(10_001);
  });
  it.each([
    { id: -1, first_name: "No" },
    { id: Number.MAX_SAFE_INTEGER + 1, first_name: "No" },
    { id: 1.5, first_name: "No" },
    { id: 1, first_name: "Bot", is_bot: true },
    { id: "1", first_name: "No" },
  ])("rejects invalid or bot identities (%j)", (user) => {
    const params = fixture(); params.set("user", JSON.stringify(user));
    expect(() => verifyTelegramInitData(signed(params), TOKEN, NOW)).toThrow(ApiError);
  });
  it("rejects signed but malformed user JSON", () => {
    const params = fixture(); params.set("user", "not json");
    expect(() => verifyTelegramInitData(signed(params), TOKEN, NOW)).toThrow(ApiError);
  });
});

describe("private short-lived Mini App sessions", () => {
  it("signs a session bound to exactly one Telegram account", () => {
    const session = createMiniSession(TOKEN, 10_001n, "https://t.me/i/userpic/photo.jpg", NOW);
    expect(verifyMiniSession(session.token, TOKEN, NOW)).toMatchObject({ telegramId: "10001", exp: NOW / 1000 + 3600 });
    expect(session.expiresAt).toBe(new Date(NOW + 3600_000).toISOString());
  });
  it("does not accept a forged owner ID in a session payload", () => {
    const issued = createMiniSession(TOKEN, 10_001n, null, NOW);
    const [payload, signature] = issued.token.split(".");
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString()); claims.telegramId = "7728424218";
    const forged = `${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${signature}`;
    expect(() => verifyMiniSession(forged, TOKEN, NOW)).toThrow(ApiError);
  });
  it("expires sessions and invalidates them after a bot-token rotation", () => {
    const issued = createMiniSession(TOKEN, 10_001n, null, NOW);
    expect(() => verifyMiniSession(issued.token, TOKEN, NOW + 3600_000)).toThrow(ApiError);
    expect(() => verifyMiniSession(issued.token, "A_DIFFERENT_BOT_TOKEN", NOW)).toThrow(ApiError);
  });
  it.each([undefined, "", "bad.payload", "x.y.z", ".", "a." + "x".repeat(10)])("rejects malformed sessions (%s)", (value) => {
    expect(() => verifyMiniSession(value, TOKEN, NOW)).toThrow(ApiError);
  });
  it.each(["javascript:alert(1)", "http://t.me/avatar.jpg", "https://evil.example/avatar.jpg", "https://t.me@evil.example/photo", "https://username:password@t.me/photo"])("never exposes an untrusted profile-photo URL (%s)", (value) => {
    expect(safePhotoUrl(value)).toBeNull();
    const session = createMiniSession(TOKEN, 10_001n, value, NOW);
    expect(verifyMiniSession(session.token, TOKEN, NOW).photoUrl).toBeNull();
  });
});

describe("Mini App public URL configuration", () => {
  it.each(["http://insecure.example", "javascript:alert(1)", "https://user:secret@example.test", "not a url"])("rejects unsafe launch URLs (%s)", (url) => {
    expect(() => loadConfig({ BOT_TOKEN: TOKEN, NODE_ENV: "test", MINI_APP_URL: url })).toThrow("MINI_APP_URL");
  });
  it("accepts a public HTTPS URL or a disabled Mini App", () => {
    expect(loadConfig({ BOT_TOKEN: TOKEN, NODE_ENV: "test", MINI_APP_URL: "https://iris.example.test" }).miniAppUrl).toBe("https://iris.example.test");
    expect(loadConfig({ BOT_TOKEN: TOKEN, NODE_ENV: "test" }).miniAppUrl).toBe("");
  });
});
