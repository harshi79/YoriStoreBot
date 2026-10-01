import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AppConfig } from "../config/env.js";
import type { Prisma, PrismaClient } from "../generated/prisma/client.js";
import type { AppLogger } from "../utils/logger.js";
import { ApiError, createMiniSession, verifyMiniSession, verifyTelegramInitData } from "./auth.js";
import { processReferralStart, getUserReferralSummary, buildReferralLink, listUserReferrals } from "../services/referrals.service.js";
import { getBonusSettings, getReferralSettings } from "../services/settings.service.js";
import { claimDailyBonus, getBonusStatus } from "../services/bonus.service.js";
import { listUserCreditTransactions } from "../services/credits.service.js";
import { redeemCode } from "../services/codes.service.js";
import { purchaseProduct, getUserPurchaseDetail, submitWarrantyClaim } from "../services/purchases.service.js";
import { BonusUnavailableError, DomainError, NotFoundError } from "../utils/errors.js";
import { buildOrderReceiptText } from "../utils/credential-parser.js";
import type { ProductDto, OrderDto, OrderDetailDto, ProfileDto } from "./contracts.js";

export const DEMO_TELEGRAM_ID = 50_001n;
export interface MiniAppDependencies {
  config: AppConfig;
  prisma: () => PrismaClient;
  logger: AppLogger;
  isReady: () => boolean;
  botUsername: () => string | null;
  demoMode?: boolean;
}

const productSelect = {
  id: true, name: true, description: true, planDetails: true, deliveryInstructions: true,
  price: true, emoji: true, featured: true, isUnlimited: true, warrantyHours: true,
  category: { select: { id: true, name: true, emoji: true } },
  _count: { select: { inventory: { where: { status: "AVAILABLE" as const } } } },
} satisfies Prisma.ProductSelect;
type CatalogProduct = Prisma.ProductGetPayload<{ select: typeof productSelect }>;
const activeProduct = { enabled: true, deletedAt: null, category: { enabled: true, deletedAt: null } };
const idSchema = z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/);

function productDto(product: CatalogProduct): ProductDto {
  const { _count, ...safe } = product;
  return { ...safe, stock: _count.inventory };
}

function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "vary": "Authorization" });
  res.end(JSON.stringify(data, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value));
}

async function readJson<T extends z.ZodType>(req: IncomingMessage, schema: T): Promise<z.infer<T>> {
  if (!(req.headers["content-type"] ?? "").startsWith("application/json")) {
    throw new ApiError(415, "CONTENT_TYPE", "Send application/json.");
  }
  const chunks: Buffer[] = [];
  let length = 0;
  let exceeded = false;
  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    length += data.length;
    if (length > 32_768) exceeded = true;
    if (!exceeded) chunks.push(data);
  }
  if (exceeded) throw new ApiError(413, "BODY_TOO_LARGE", "That request is too large.");
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
  catch { throw new ApiError(400, "BAD_JSON", "Send valid JSON."); }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError(400, "VALIDATION", "Check the request fields and try again.");
  return parsed.data;
}

function pageQuery(url: URL): number {
  const page = Number(url.searchParams.get("page") ?? 0);
  if (!Number.isSafeInteger(page) || page < 0 || page > 10_000) throw new ApiError(400, "VALIDATION", "That page is invalid.");
  return page;
}

async function profileDto(deps: MiniAppDependencies, telegramId: string, photoUrl: string | null): Promise<ProfileDto> {
  const db = deps.prisma();
  const user = await db.user.findUnique({ where: { telegramId: BigInt(telegramId) } });
  if (!user) throw new ApiError(401, "SESSION_EXPIRED", "Your profile was reset. Reopen Iris through Telegram.");
  const [bonusSettings, referralSettings, referrals, orders, items, spent, saved] = await Promise.all([
    getBonusSettings(db, { credits: deps.config.bonusCredits, periodHours: deps.config.bonusPeriodHours }),
    getReferralSettings(db, { referrerCredits: deps.config.referralRewardCredits, inviteeCredits: deps.config.referralWelcomeCredits }),
    getUserReferralSummary(db, user.id),
    db.purchase.count({ where: { buyerId: user.id, batchIndex: 0 } }),
    db.purchase.count({ where: { buyerId: user.id } }),
    db.purchase.aggregate({ where: { buyerId: user.id }, _sum: { amountPaid: true } }),
    db.wishlistItem.count({ where: { userId: user.id, product: activeProduct } }),
  ]);
  const bonus = await getBonusStatus(db, user.id, bonusSettings.periodHours);
  const username = deps.botUsername();
  return {
    id: user.id, telegramId: user.telegramId.toString(), firstName: user.firstName || "friend", lastName: user.lastName,
    username: user.username, photoUrl, credits: user.credits, createdAt: user.createdAt.toISOString(),
    isOwner: user.telegramId === deps.config.ownerId,
    stats: { orders, items, spent: spent._sum.amountPaid ?? 0, saved },
    bonus: { ...bonusSettings, ...bonus, nextAvailableAt: bonus.nextAvailableAt?.toISOString() ?? null },
    referrals: {
      count: referrals.totalReferrals, earned: referrals.totalEarned, reward: referralSettings.referrerCredits,
      welcome: referralSettings.inviteeCredits, enabled: referralSettings.enabled,
      link: username ? buildReferralLink(username, user.telegramId) : null,
    },
  };
}

export async function getMiniOrderDetail(db: PrismaClient, userId: string, purchaseId: string): Promise<OrderDetailDto> {
  const selected = await getUserPurchaseDetail(db, userId, purchaseId);
  const items = await db.purchase.findMany({
    where: { batchId: selected.batchId, buyerId: userId, productId: selected.productId },
    orderBy: { batchIndex: "asc" }, include: { inventoryItem: true, warrantyClaim: true },
  });
  const root = items[0];
  if (!root || root.batchIndex !== 0) throw new NotFoundError("That order is not available.");
  const deliveries = await Promise.all(items.map(async (item) => {
    let payload = item.inventoryItem.payload;
    let replaced = false;
    const claim = item.warrantyClaim;
    if (claim?.status === "REPLACED" && claim.replacementItemId) {
      const replacement = await db.inventoryItem.findFirst({ where: { id: claim.replacementItemId, purchaserId: userId, status: "SOLD" } });
      if (replacement) { payload = replacement.payload; replaced = true; }
    }
    return {
      id: item.id, payload, replaced,
      claim: claim ? { id: claim.id, status: claim.status, reason: claim.reason, resolutionNote: claim.resolutionNote } : null,
    };
  }));
  return {
    id: root.id, productId: selected.productId, productName: selected.product.name, productEmoji: selected.product.emoji,
    category: selected.product.category.name, paid: items.reduce((sum, item) => sum + item.amountPaid, 0),
    quantity: items.length, createdAt: root.createdAt.toISOString(), warrantyHours: selected.product.warrantyHours,
    warrantyExpiresAt: new Date(root.createdAt.getTime() + selected.product.warrantyHours * 3_600_000).toISOString(),
    claimStatus: deliveries.find((item) => item.claim)?.claim?.status ?? null,
    planDetails: selected.product.planDetails, deliveryInstructions: selected.product.deliveryInstructions, items: deliveries,
  };
}

export function createMiniAppServer(deps: MiniAppDependencies, staticDirectory = fileURLToPath(new URL("../../web/dist", import.meta.url))): Server {
  if (deps.demoMode && (deps.config.nodeEnv === "production" || deps.config.databaseUrl)) {
    throw new Error("Demo authentication cannot run in production or against a configured PostgreSQL store.");
  }
  const rateLimits = new Map<string, { expires: number; calls: number }>();
  function rate(key: string, limit: number) {
    const now = Date.now();
    if (rateLimits.size > 5000) for (const [oldKey, value] of rateLimits) if (value.expires <= now) rateLimits.delete(oldKey);
    let entry = rateLimits.get(key);
    if (!entry || entry.expires <= now) {
      if (rateLimits.size >= 10_000) throw new ApiError(429, "RATE_LIMIT", "The store is busy. Try again shortly.");
      entry = { expires: now + 60_000, calls: 0 }; rateLimits.set(key, entry);
    }
    entry.calls += 1;
    if (entry.calls > limit) throw new ApiError(429, "RATE_LIMIT", "A little too fast. Please wait a minute and try again.");
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "strict-origin-when-cross-origin");
    const url = new URL(req.url ?? "/", "http://iris.internal");
    const path = url.pathname;
    const method = req.method ?? "GET";
    if ((path === "/health" || path === "/healthz") && (method === "GET" || method === "HEAD")) {
      json(res, deps.isReady() ? 200 : 503, { status: deps.isReady() ? "ok" : "not_ready", service: "iris-credit-store-bot" }); return;
    }
    if (path === "/api/config" && method === "GET") {
      json(res, 200, { demoMode: !!deps.demoMode, ready: deps.isReady(), botUsername: deps.botUsername(), supportUrl: "https://t.me/YoriNetwork" }); return;
    }
    if (path.startsWith("/api/")) {
      if (!deps.isReady()) throw new ApiError(503, "NOT_READY", "The store is getting ready. Try again in a moment.");
      if (method !== "GET" && method !== "HEAD") {
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) throw new ApiError(403, "ORIGIN", "This request origin is not allowed.");
      }
      const db = deps.prisma();
      if (path === "/api/auth/telegram" && method === "POST") {
        rate(`auth:${req.socket.remoteAddress}`, 80);
        const input = await readJson(req, z.object({ initData: z.string().min(1).max(16_384) }).strict());
        const verified = verifyTelegramInitData(input.initData, deps.config.botToken);
        const result = await processReferralStart(db, {
          id: verified.user.id, first_name: verified.user.first_name, is_bot: false,
          ...(verified.user.last_name !== undefined ? { last_name: verified.user.last_name } : {}),
          ...(verified.user.username !== undefined ? { username: verified.user.username } : {}),
        }, verified.startParam, {
          referrerCredits: deps.config.referralRewardCredits, inviteeCredits: deps.config.referralWelcomeCredits,
        });
        json(res, 200, createMiniSession(deps.config.botToken, result.user.telegramId, verified.user.photo_url ?? null)); return;
      }
      if (path === "/api/auth/demo" && method === "POST") {
        if (!deps.demoMode) throw new ApiError(404, "NOT_FOUND", "That endpoint does not exist.");
        rate(`demo-auth:${req.socket.remoteAddress}`, 80);
        await readJson(req, z.object({}).strict());
        json(res, 200, createMiniSession(deps.config.botToken, DEMO_TELEGRAM_ID)); return;
      }
      // Public catalog exposes only explicitly selected non-secret fields.
      if (path === "/api/catalog" && method === "GET") {
        rate(`catalog:${req.socket.remoteAddress}`, 160);
        const query = z.string().max(100).parse(url.searchParams.get("query") ?? "").trim();
        const categoryId = url.searchParams.get("category");
        if (categoryId) idSchema.parse(categoryId);
        const sort = z.enum(["featured", "price_asc", "price_desc", "newest"]).parse(url.searchParams.get("sort") ?? "featured");
        const where: Prisma.ProductWhereInput = {
          ...activeProduct,
          ...(categoryId ? { categoryId } : {}),
          ...(query ? { OR: [{ name: { contains: query, mode: "insensitive" } }, { description: { contains: query, mode: "insensitive" } }] } : {}),
        };
        const page = pageQuery(url);
        const [products, total, categories] = await Promise.all([
          db.product.findMany({ where, select: productSelect, skip: page * 12, take: 12, orderBy: sort === "price_asc" ? [{ price: "asc" }, { id: "asc" }] : sort === "price_desc" ? [{ price: "desc" }, { id: "asc" }] : sort === "newest" ? [{ createdAt: "desc" }, { id: "asc" }] : [{ featured: "desc" }, { createdAt: "asc" }, { id: "asc" }] }),
          db.product.count({ where }),
          db.category.findMany({ where: { enabled: true, deletedAt: null }, orderBy: [{ displayOrder: "asc" }, { name: "asc" }], select: { id: true, name: true, emoji: true, _count: { select: { products: { where: { enabled: true, deletedAt: null } } } } } }),
        ]);
        json(res, 200, { products: products.map(productDto), total, page, pages: Math.max(1, Math.ceil(total / 12)), categories: categories.map(({ _count, ...category }) => ({ ...category, count: _count.products })) }); return;
      }
      const authHeader = req.headers.authorization;
      const session = verifyMiniSession(authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined, deps.config.botToken);
      const user = await db.user.findUnique({ where: { telegramId: BigInt(session.telegramId) } });
      if (!user) throw new ApiError(401, "SESSION_EXPIRED", "Your profile is not ready. Reopen Iris from Telegram.");
      rate(`user:${user.id}`, method === "GET" ? 160 : 40);

      if (path === "/api/profile" && method === "GET") {
        json(res, 200, await profileDto(deps, session.telegramId, session.photoUrl)); return;
      }
      if (path === "/api/wallet" && method === "GET") {
        json(res, 200, await listUserCreditTransactions(db, user.id, pageQuery(url), 12)); return;
      }
      if (path === "/api/bonus" && method === "POST") {
        await readJson(req, z.object({}).strict());
        const settings = await getBonusSettings(db, { credits: deps.config.bonusCredits, periodHours: deps.config.bonusPeriodHours });
        json(res, 200, await claimDailyBonus(db, user.id, settings.credits, settings.periodHours)); return;
      }
      if (path === "/api/redeem" && method === "POST") {
        rate(`redeem:${user.id}`, 8);
        const input = await readJson(req, z.object({ code: z.string().trim().min(1).max(32) }).strict());
        json(res, 200, await redeemCode(db, user.id, input.code)); return;
      }
      if (path === "/api/purchases" && method === "POST") {
        const input = await readJson(req, z.object({
          productId: idSchema, quantity: z.number().int().min(1).max(10),
          expectedPrice: z.number().int().min(0).max(1_000_000_000),
          idempotencyKey: z.string().min(16).max(80).regex(/^[a-zA-Z0-9_-]+$/),
        }).strict());
        const purchase = await purchaseProduct(db, user.id, input.productId, `mini:${session.telegramId}:${input.idempotencyKey}`, input.expectedPrice, input.quantity);
        json(res, 200, { purchaseId: purchase.purchaseId, productName: purchase.productName, paid: purchase.paid, quantity: purchase.quantity, remainingCredits: purchase.remainingCredits, repeated: purchase.repeated }); return;
      }
      if (path === "/api/wishlist" && method === "GET") {
        const saved = await db.wishlistItem.findMany({ where: { userId: user.id, product: activeProduct }, orderBy: { createdAt: "desc" }, select: { product: { select: productSelect } } });
        json(res, 200, { products: saved.map((item) => productDto(item.product)) }); return;
      }
      const wishlistMatch = /^\/api\/wishlist\/([^/]+)$/.exec(path);
      if (wishlistMatch && method === "PUT") {
        const productId = idSchema.parse(decodeURIComponent(wishlistMatch[1]!));
        const input = await readJson(req, z.object({ saved: z.boolean() }).strict());
        if (input.saved) {
          const product = await db.product.findFirst({ where: { id: productId, ...activeProduct }, select: { id: true } });
          if (!product) throw new NotFoundError("That product is no longer available.");
          await db.wishlistItem.upsert({ where: { userId_productId: { userId: user.id, productId } }, create: { userId: user.id, productId }, update: {} });
        } else await db.wishlistItem.deleteMany({ where: { userId: user.id, productId } });
        json(res, 200, { saved: input.saved }); return;
      }
      const subscriptionMatch = /^\/api\/subscriptions\/([^/]+)$/.exec(path);
      if (subscriptionMatch && method === "PUT") {
        const productId = idSchema.parse(decodeURIComponent(subscriptionMatch[1]!));
        const input = await readJson(req, z.object({ subscribed: z.boolean() }).strict());
        const product = await db.product.findFirst({ where: { id: productId, ...activeProduct }, select: { id: true } });
        if (!product) throw new NotFoundError();
        if (input.subscribed) await db.stockSubscription.upsert({ where: { userId_productId: { userId: user.id, productId } }, create: { userId: user.id, productId }, update: {} });
        else await db.stockSubscription.deleteMany({ where: { userId: user.id, productId } });
        json(res, 200, { subscribed: input.subscribed }); return;
      }
      if (path === "/api/referrals" && method === "GET") {
        json(res, 200, await listUserReferrals(db, user.id, pageQuery(url), 12)); return;
      }
      if (path === "/api/orders" && method === "GET") {
        const page = pageQuery(url);
        const where = { buyerId: user.id, batchIndex: 0 };
        const [roots, total] = await Promise.all([
          db.purchase.findMany({ where, skip: page * 12, take: 12, orderBy: [{ createdAt: "desc" }, { id: "desc" }], include: { product: { include: { category: { select: { name: true } } } } } }),
          db.purchase.count({ where }),
        ]);
        const items = await db.purchase.findMany({ where: { buyerId: user.id, batchId: { in: roots.map((root) => root.batchId) } }, select: { batchId: true, amountPaid: true, warrantyClaim: { select: { status: true } } } });
        const orders: OrderDto[] = roots.map((root) => {
          const batch = items.filter((item) => item.batchId === root.batchId);
          return { id: root.id, productId: root.productId, productName: root.product.name, productEmoji: root.product.emoji, category: root.product.category.name, paid: batch.reduce((sum, item) => sum + item.amountPaid, 0), quantity: batch.length, createdAt: root.createdAt.toISOString(), warrantyHours: root.product.warrantyHours, claimStatus: batch.find((item) => item.warrantyClaim)?.warrantyClaim?.status ?? null };
        });
        json(res, 200, { orders, total, page, pages: Math.max(1, Math.ceil(total / 12)) }); return;
      }
      const receiptMatch = /^\/api\/orders\/([^/]+)\/receipt$/.exec(path);
      if (receiptMatch && method === "GET") {
        const order = await getMiniOrderDetail(db, user.id, idSchema.parse(decodeURIComponent(receiptMatch[1]!)));
        const content = [
          "IRIS · PRIVATE ORDER RECEIPT", `Order: ${order.id}`, `Product: ${order.productName}`,
          `Quantity: ${order.quantity}`, `Total paid: ${order.paid} credits`, "",
          ...order.items.map((item, index) => `ITEM ${index + 1} OF ${order.quantity}\n` + buildOrderReceiptText({ purchaseId: item.id, productName: order.productName, categoryName: order.category, paid: order.paid / order.quantity, createdAt: new Date(order.createdAt), payload: item.payload, planDetails: order.planDetails, deliveryInstructions: order.deliveryInstructions, warrantyHours: order.warrantyHours })),
        ].join("\n");
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "content-disposition": `attachment; filename="iris-order-${order.id.slice(0, 8)}.txt"` }); res.end(content); return;
      }
      const orderMatch = /^\/api\/orders\/([^/]+)$/.exec(path);
      if (orderMatch && method === "GET") {
        json(res, 200, await getMiniOrderDetail(db, user.id, idSchema.parse(decodeURIComponent(orderMatch[1]!)))); return;
      }
      const claimMatch = /^\/api\/orders\/([^/]+)\/claim$/.exec(path);
      if (claimMatch && method === "POST") {
        const input = await readJson(req, z.object({ reason: z.string().trim().min(3).max(500) }).strict());
        json(res, 201, await submitWarrantyClaim(db, user.id, idSchema.parse(decodeURIComponent(claimMatch[1]!)), input.reason)); return;
      }
      throw new ApiError(404, "NOT_FOUND", "That endpoint does not exist.");
    }
    if (method !== "GET" && method !== "HEAD") throw new ApiError(404, "NOT_FOUND", "That page does not exist.");
    res.setHeader("content-security-policy", "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: https://t.me https://*.telegram.org https://*.telegram-cdn.org; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'");
    const decoded = decodeURIComponent(path);
    if (decoded.split("/").some((part) => part.startsWith(".")) || decoded.includes("\0")) throw new ApiError(404, "NOT_FOUND", "That asset does not exist.");
    let file = resolve(staticDirectory, `.${decoded}`);
    if (file !== resolve(staticDirectory) && !file.startsWith(resolve(staticDirectory) + sep)) throw new ApiError(404, "NOT_FOUND", "That asset does not exist.");
    try {
      const info = await stat(file);
      if (info.isDirectory()) file = resolve(file, "index.html");
    } catch {
      if (extname(path)) throw new ApiError(404, "NOT_FOUND", "That asset does not exist.");
      file = resolve(staticDirectory, "index.html");
    }
    let content: Buffer;
    try { content = await readFile(file); }
    catch { json(res, deps.isReady() ? 404 : 503, { status: deps.isReady() ? "ok" : "not_ready", message: "Build the Mini App with npm run mini:build.", service: "iris-credit-store-bot" }); return; }
    const mime: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
    const type = extname(file);
    res.writeHead(type === ".html" && !deps.isReady() ? 503 : 200, { "content-type": mime[type] ?? "application/octet-stream", "cache-control": type === ".html" ? "no-cache" : "public, max-age=3600" });
    res.end(method === "HEAD" ? undefined : content);
  }

  return createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (res.headersSent) { res.end(); return; }
      let status = 500, code = "INTERNAL", message = "Something went wrong. Please try again.";
      if (error instanceof ApiError) { status = error.status; code = error.code; message = error.message; }
      else if (error instanceof z.ZodError || error instanceof URIError || error instanceof TypeError) { status = 400; code = "VALIDATION"; message = "Check your request and try again."; }
      else if (error instanceof DomainError) { status = error.code === "NOT_FOUND" ? 404 : error.code === "VALIDATION" ? 400 : 409; code = error.code; message = error.message; }
      if (status === 500) deps.logger.error({ route: req.url?.split("?")[0], code }, "Mini App request failed");
      if (status === 429) res.setHeader("retry-after", "60");
      json(res, status, { error: { code, message, ...(error instanceof BonusUnavailableError ? { nextAvailableAt: error.nextAvailableAt.toISOString() } : {}) } });
    });
  });
}

export function listenMiniApp(server: Server, port: number): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => { server.removeListener("error", reject); resolvePromise(); });
  });
}
