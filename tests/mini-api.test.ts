import { readFile, readdir } from "node:fs/promises";
import { createHmac, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { PGlite } from "@electric-sql/pglite";
import { PrismaPGlite } from "pglite-prisma-adapter";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { loadConfig } from "../src/config/env.js";
import type { AppLogger } from "../src/utils/logger.js";
import { createMiniAppServer, listenMiniApp } from "../src/mini-app/server.js";
import { createMiniSession } from "../src/mini-app/auth.js";
import { createCategory, createProduct, addInventoryItems, updateProduct } from "../src/services/store.service.js";
import { changeCredits } from "../src/services/credits.service.js";
import { buildStoreExport } from "../src/services/export.service.js";
import type { OrderDetailDto, ProfileDto, PurchaseDto, OrdersDto, CatalogDto } from "../src/mini-app/contracts.js";

const config = loadConfig({ BOT_TOKEN: "TEST_MINI_API_TOKEN_NOT_A_REAL_CREDENTIAL", DATABASE_URL: "", NODE_ENV: "test" });
const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() } as unknown as AppLogger;
let pg: PGlite, db: PrismaClient, server: Server, base: string, userId: string, otherId: string, productId: string;
let ready = true;
const userToken = () => createMiniSession(config.botToken, 61_001n).token;
const otherToken = () => createMiniSession(config.botToken, 61_002n).token;

async function request<T = Record<string, unknown>>(path: string, options: { method?: string; body?: unknown; token?: string; origin?: string } = {}) {
  const response = await fetch(base + path, {
    method: options.method ?? "GET",
    headers: { ...(options.token ? { authorization: `Bearer ${options.token}` } : {}), ...(options.body !== undefined ? { "content-type": "application/json" } : {}), ...(options.origin ? { origin: options.origin } : {}) },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const body = await response.json() as T;
  return { status: response.status, body, headers: response.headers };
}
function telegramData(id: number) {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id, first_name: "Verified friend", username: "verified_friend" }), query_id: randomUUID() });
  const check = [...params.entries()].sort(([a], [b]) => a < b ? -1 : 1).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(config.botToken).digest();
  params.set("hash", createHmac("sha256", secret).update(check).digest("hex")); return params.toString();
}

beforeAll(async () => {
  pg = new PGlite();
  const root = new URL("../prisma/migrations/", import.meta.url);
  for (const name of (await readdir(root)).sort()) if (/^\d/.test(name)) await pg.exec(await readFile(new URL(`${name}/migration.sql`, root), "utf8"));
  db = new PrismaClient({ adapter: new PrismaPGlite(pg) }); await db.$connect();
  server = createMiniAppServer({ config, logger, prisma: () => db, isReady: () => ready, botUsername: () => "iris_test_bot" });
  await listenMiniApp(server, 0); const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test API did not listen");
  base = `http://127.0.0.1:${address.port}`;
}, 60_000);
afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await db?.$disconnect(); await pg?.close();
}, 30_000);
beforeEach(async () => {
  ready = true;
  await db.wishlistItem.deleteMany(); await db.warrantyClaim.deleteMany(); await db.stockSubscription.deleteMany();
  await db.purchase.deleteMany(); await db.codeRedemption.deleteMany(); await db.inventoryItem.deleteMany();
  await db.creditTransaction.deleteMany(); await db.redeemCode.deleteMany(); await db.product.deleteMany();
  await db.category.deleteMany(); await db.user.deleteMany(); await db.appSetting.deleteMany();
  const user = await db.user.create({ data: { telegramId: 61_001n, firstName: "Alice", username: "alice" } }); userId = user.id;
  const other = await db.user.create({ data: { telegramId: 61_002n, firstName: "Other" } }); otherId = other.id;
  await changeCredits(db, { userId, amount: 800, type: "GIFT", description: "Fixture gift" });
  const category = await createCategory(db, { name: "Test collection" });
  const product = await createProduct(db, { categoryId: category.id, name: "Private design pack", price: 40, warrantyHours: 24 }); productId = product.id;
  await addInventoryItems(db, productId, ["PRIVATE-DELIVERY-ONE", "PRIVATE-DELIVERY-TWO", "PRIVATE-DELIVERY-THREE", "PRIVATE-DELIVERY-FOUR"]);
});

describe("Mini App HTTP security and database workflows", () => {
  it("exposes a secret-free public catalog and no bot token or database URL", async () => {
    const catalog = await request<CatalogDto>("/api/catalog"); expect(catalog.status).toBe(200);
    expect(catalog.body.products[0]).toMatchObject({ id: productId, price: 40, stock: 4, imageUrl: null });
    expect(JSON.stringify(catalog.body)).not.toMatch(/PRIVATE-DELIVERY|payloadHash|payload_hash|botToken|databaseUrl/);
    const publicConfig = await request("/api/config"); expect(JSON.stringify(publicConfig.body)).not.toContain(config.botToken);
    expect(publicConfig.body.demoMode).toBe(false);
  });
  it("publishes the owner-set product image link on the catalog and on the buyer's own order", async () => {
    const image = "https://cdn.example.com/art/pack.png";
    await updateProduct(db, productId, { imageUrl: image });
    const catalog = await request<CatalogDto>("/api/catalog");
    expect(catalog.body.products[0]!.imageUrl).toBe(image);
    // A Telegram file_id stays server-side: it is never published to the browser as an image link.
    await updateProduct(db, productId, { mediaFileId: "AgACAgUAAxkBAAIB-secret-file-id" });
    expect(JSON.stringify((await request<CatalogDto>("/api/catalog")).body)).not.toContain("secret-file-id");
    const purchase = await request<PurchaseDto>("/api/purchases", { token: userToken(), method: "POST", body: { productId, quantity: 2, expectedPrice: 40, idempotencyKey: randomUUID() } });
    expect(purchase.status).toBe(200);
    const list = await request<OrdersDto>("/api/orders", { token: userToken() });
    expect(list.body.orders[0]!.productImageUrl).toBe(image);
    const detail = await request<OrderDetailDto>(`/api/orders/${purchase.body.purchaseId}`, { token: userToken() });
    expect(detail.body.productImageUrl).toBe(image);
    expect(JSON.stringify((await request<OrdersDto>("/api/orders", { token: userToken() })).body)).not.toContain("secret-file-id");
  });
  it("requires a verified session for every private account endpoint", async () => {
    for (const path of ["/api/profile", "/api/wallet", "/api/orders", "/api/wishlist", "/api/referrals"]) {
      const result = await request(path); expect(result.status).toBe(401);
      expect(result.headers.get("cache-control")).toBe("no-store");
    }
  });
  it("does not expose demo authentication in a real API", async () => {
    expect((await request("/api/auth/demo", { method: "POST", body: {} })).status).toBe(404);
    expect(() => createMiniAppServer({ config: { ...config, nodeEnv: "production" }, logger, prisma: () => db, isReady: () => true, botUsername: () => null, demoMode: true })).toThrow(/Demo authentication/);
    expect(() => createMiniAppServer({ config: { ...config, databaseUrl: "postgresql://localhost/store" }, logger, prisma: () => db, isReady: () => true, botUsername: () => null, demoMode: true })).toThrow(/Demo authentication/);
  });
  it("creates a profile from signed Telegram data, never from an unsigned body user ID", async () => {
    const auth = await request<{ token: string }>("/api/auth/telegram", { method: "POST", body: { initData: telegramData(61_003) } });
    expect(auth.status).toBe(200); expect((await request<ProfileDto>("/api/profile", { token: auth.body.token })).body.telegramId).toBe("61003");
    const forged = new URLSearchParams(telegramData(61_003)); forged.set("user", JSON.stringify({ id: Number(config.ownerId), first_name: "Owner" }));
    expect((await request("/api/auth/telegram", { method: "POST", body: { initData: forged.toString() } })).status).toBe(401);
    expect(await db.user.findUnique({ where: { telegramId: config.ownerId } })).toBeNull();
  });
  it("keeps balances and profile statistics in the database", async () => {
    const profile = await request<ProfileDto>("/api/profile", { token: userToken() });
    expect(profile.body).toMatchObject({ credits: 800, telegramId: "61001", firstName: "Alice", stats: { orders: 0, items: 0, spent: 0, saved: 0 } });
    expect(profile.body.referrals.link).toBe("https://t.me/iris_test_bot?start=ref_61001");
  });
  it("rejects forged credit/identity fields and invalid quantities without reserving stock", async () => {
    const body = { productId, quantity: 1, expectedPrice: 40, idempotencyKey: randomUUID() };
    expect((await request("/api/purchases", { token: userToken(), method: "POST", body: { ...body, userId: otherId } })).status).toBe(400);
    expect((await request("/api/purchases", { token: userToken(), method: "POST", body: { ...body, credits: 9999 } })).status).toBe(400);
    expect((await request("/api/purchases", { token: userToken(), method: "POST", body: { ...body, quantity: 11 } })).status).toBe(400);
    expect(await db.purchase.count()).toBe(0); expect((await db.user.findUniqueOrThrow({ where: { id: userId } })).credits).toBe(800);
  });
  it("purchases a whole batch once, returns correct history, and preserves private delivery ownership", async () => {
    const body = { productId, quantity: 3, expectedPrice: 40, idempotencyKey: randomUUID() };
    const first = await request<PurchaseDto>("/api/purchases", { token: userToken(), method: "POST", body });
    const replay = await request<PurchaseDto>("/api/purchases", { token: userToken(), method: "POST", body: { ...body, quantity: 1 } });
    expect(first.status).toBe(200); expect(first.body).toMatchObject({ paid: 120, quantity: 3, remainingCredits: 680, repeated: false });
    expect(replay.body).toMatchObject({ purchaseId: first.body.purchaseId, paid: 120, quantity: 3, repeated: true });
    const list = await request<OrdersDto>("/api/orders", { token: userToken() }); expect(list.body.total).toBe(1); expect(list.body.orders[0]).toMatchObject({ quantity: 3, paid: 120 });
    expect(JSON.stringify(list.body)).not.toContain("PRIVATE-DELIVERY");
    const detail = await request<OrderDetailDto>(`/api/orders/${first.body.purchaseId}`, { token: userToken() }); expect(detail.body.items).toHaveLength(3);
    expect(detail.body.items.every((item) => item.payload.startsWith("PRIVATE-DELIVERY"))).toBe(true);
    expect((await request(`/api/orders/${first.body.purchaseId}`, { token: otherToken() })).status).toBe(404);
    expect((await request(`/api/orders/${first.body.purchaseId}/receipt`, { token: otherToken() })).status).toBe(404);
    const receipt = await fetch(base + `/api/orders/${first.body.purchaseId}/receipt`, { headers: { authorization: `Bearer ${userToken()}` } });
    const text = await receipt.text(); expect(receipt.status).toBe(200); expect(text).toContain("Total paid: 120 credits"); expect(text).toContain("ITEM 3 OF 3");
    expect(await db.creditTransaction.count({ where: { type: "PURCHASE" } })).toBe(1);
    expect((await db.inventoryItem.count({ where: { status: "AVAILABLE" } }))).toBe(1);
  });
  it("enforces the reviewed product price before charging", async () => {
    await db.product.update({ where: { id: productId }, data: { price: 60 } });
    const result = await request("/api/purchases", { token: userToken(), method: "POST", body: { productId, quantity: 2, expectedPrice: 40, idempotencyKey: randomUUID() } });
    expect(result.status).toBe(409); expect(await db.purchase.count()).toBe(0);
  });
  it("persists wishlist changes idempotently and keeps them scoped to the customer", async () => {
    for (let i = 0; i < 2; i++) expect((await request(`/api/wishlist/${productId}`, { token: userToken(), method: "PUT", body: { saved: true } })).status).toBe(200);
    expect(await db.wishlistItem.count()).toBe(1);
    expect((await request<ProfileDto>("/api/profile", { token: userToken() })).body.stats.saved).toBe(1);
    expect((await request<{ products: unknown[] }>("/api/wishlist", { token: otherToken() })).body.products).toEqual([]);
    expect((await buildStoreExport(db)).wishlist).toHaveLength(1);
    await request(`/api/wishlist/${productId}`, { token: userToken(), method: "PUT", body: { saved: false } }); expect(await db.wishlistItem.count()).toBe(0);
  });
  it("writes only one daily bonus and matching wallet activity", async () => {
    expect((await request("/api/bonus", { token: userToken(), method: "POST", body: {} })).status).toBe(200);
    expect((await request("/api/bonus", { token: userToken(), method: "POST", body: {} })).status).toBe(409);
    expect((await db.user.findUniqueOrThrow({ where: { id: userId } })).credits).toBe(825);
    expect(await db.creditTransaction.count({ where: { type: "BONUS" } })).toBe(1);
  });
  it("redeems a gift code once and never accepts caller-selected credit amounts", async () => {
    await db.redeemCode.create({ data: { code: "IRIS-TEST-GIFT-CODE", creditAmount: 50, maxRedeems: 10, createdBy: config.ownerId } });
    expect((await request("/api/redeem", { token: userToken(), method: "POST", body: { code: "IRIS-TEST-GIFT-CODE", amount: 99999 } })).status).toBe(400);
    expect((await request("/api/redeem", { token: userToken(), method: "POST", body: { code: "IRIS-TEST-GIFT-CODE" } })).status).toBe(200);
    expect((await request("/api/redeem", { token: userToken(), method: "POST", body: { code: "IRIS-TEST-GIFT-CODE" } })).status).toBe(409);
    expect((await db.user.findUniqueOrThrow({ where: { id: userId } })).credits).toBe(850);
  });
  it("accepts only a customer's own delivery-issue claim", async () => {
    const result = await request<PurchaseDto>("/api/purchases", { token: userToken(), method: "POST", body: { productId, quantity: 1, expectedPrice: 40, idempotencyKey: randomUUID() } });
    expect((await request(`/api/orders/${result.body.purchaseId}/claim`, { token: otherToken(), method: "POST", body: { reason: "Delivery problem" } })).status).toBe(404);
    expect((await request(`/api/orders/${result.body.purchaseId}/claim`, { token: userToken(), method: "POST", body: { reason: "Delivery problem" } })).status).toBe(201);
    expect(await db.warrantyClaim.count()).toBe(1);
  });
  it("stores restock subscriptions idempotently in the same bot database", async () => {
    for (let i = 0; i < 2; i++) await request(`/api/subscriptions/${productId}`, { token: userToken(), method: "PUT", body: { subscribed: true } });
    expect(await db.stockSubscription.count({ where: { userId } })).toBe(1);
  });
  it("rejects cross-origin mutations and safely handles offline/readiness states", async () => {
    expect((await request("/api/bonus", { token: userToken(), origin: "https://untrusted.example", method: "POST", body: {} })).status).toBe(403);
    ready = false;
    expect((await request("/api/profile", { token: userToken() })).status).toBe(503);
    expect((await request("/health")).status).toBe(503); ready = true;
    expect((await request("/health")).status).toBe(200);
  });
});
