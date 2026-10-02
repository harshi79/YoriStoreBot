import { readdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { PrismaPGlite } from "pglite-prisma-adapter";
import { GrammyError, InlineKeyboard } from "grammy";
import type { Api } from "grammy";
import type { Update, User as TelegramUser } from "grammy/types";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { createBot } from "../src/bot/create-bot.js";
import { COMMAND_MENU, PUBLIC_COMMANDS, registerCommandMenus } from "../src/bot/command-menu.js";
import { editOrReply, editOrReplyRich } from "../src/bot/render.js";
import type { BotContext } from "../src/types/context.js";
import type { AppLogger } from "../src/utils/logger.js";
import { touchUser } from "../src/services/users.service.js";
import {
  addInventoryItems, applyProductPreset, archiveCategory, archiveProduct, clearAvailableInventory,
  cloneProduct, consumeStockSubscribers, countAvailableInventory, createCategory, createProduct,
  getAvailableInventoryItem, isSubscribedToStock, listAllAvailablePayloads,
  listAvailableInventory, listCategoryProducts, listEnabledCategories, listFeaturedProducts,
  removeInventoryItem, reorderCategory, searchProducts, toggleStockSubscription,
  updateCategory, updateProduct,
} from "../src/services/store.service.js";
import {
  getUserPurchaseDetail, listWarrantyClaims, purchaseProduct,
  resolveWarrantyClaimReplace, submitWarrantyClaim,
} from "../src/services/purchases.service.js";
import { buildOrderReceiptText, parseDeliveryPayload } from "../src/utils/credential-parser.js";
import { claimDailyBonus } from "../src/services/bonus.service.js";
import { createRedeemCodes, redeemCode } from "../src/services/codes.service.js";
import { changeCredits, giftAllActiveUsers, giftCredits, listUserCreditTransactions, MAX_CREDITS, removeCredits } from "../src/services/credits.service.js";
import {
  buildReferralLink,
  getUserReferralSummary,
  listUserReferrals,
  parseReferralStartPayload,
  processReferralStart,
} from "../src/services/referrals.service.js";
import {
  updateBonusSettings,
  getBonusSettings,
  getReferralSettings,
  toggleReferralEnabled,
  updateReferralSettings,
} from "../src/services/settings.service.js";
import { cancelResetChallenge, createResetChallenge, advanceResetChallenge, performConfirmedReset } from "../src/services/admin.service.js";
import { buildStoreExport } from "../src/services/export.service.js";
import { broadcastToUsers } from "../src/services/broadcast.service.js";
import { AlreadyRedeemedError, BonusUnavailableError, CodeUnavailableError, InsufficientCreditsError, OutOfStockError, PriceChangedError, ValidationError } from "../src/utils/errors.js";
import { loadConfig } from "../src/config/env.js";
import { createDatabase } from "../src/db/client.js";
import { purchaseDeliveryMessage, welcomeMessage } from "../src/messages/iris.js";
import { smallCaps } from "../src/utils/format.js";

const OWNER_ID = 7_728_424_218n;
// Every committed migration, in chronological order, so a new column added to
// prisma/schema.prisma is exercised here without editing this file again.
const migrationsRoot = new URL("../prisma/migrations/", import.meta.url);

let pg: PGlite | undefined;
let postgresPool: Pool | undefined;
let postgresSchema: string;
let prisma: PrismaClient;

function createTestClient(): PrismaClient {
  if (postgresPool) return new PrismaClient({ adapter: new PrismaPg(postgresPool, { schema: postgresSchema }) });
  if (!pg) throw new Error("Test database is not initialized");
  return new PrismaClient({ adapter: new PrismaPGlite(pg) });
}

async function makeUser(telegramId: bigint, credits = 0, lastActiveAt = new Date()) {
  return prisma.user.create({ data: { telegramId, credits, lastActiveAt } });
}

async function makeProduct(name = "Digital item", price = 50) {
  const category = await createCategory(prisma, { name: `${name} category` });
  const product = await createProduct(prisma, { categoryId: category.id, name, price });
  return { category, product };
}

interface CapturedApiCall {
  method: string;
  payload: Record<string, unknown>;
}

function makeTestBot(miniAppUrl = "") {
  const config = loadConfig({
    BOT_TOKEN: "TEST_TOKEN_NOT_A_REAL_CREDENTIAL",
    DATABASE_URL: "postgresql://localhost:5432/iris_test",
    NODE_ENV: "test",
    MINI_APP_URL: miniAppUrl,
  });
  const logger = {
    trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(),
  } as unknown as AppLogger;
  const bot = createBot({ config, database: { prisma, close: async () => undefined }, logger });
  bot.botInfo = {
    id: 1_234_567, is_bot: true, first_name: "Iris test", username: "iris_test_bot",
    can_join_groups: false,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
    can_manage_bots: false,
    supports_join_request_queries: false,
  };
  const calls: CapturedApiCall[] = [];
  let messageId = 1_000;
  bot.api.config.use(async (_previous, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    if (method === "sendMessage" || method === "sendRichMessage") {
      const send = payload as { chat_id: number | string; text?: string; rich_message?: unknown };
      return {
        ok: true,
        result: {
          message_id: messageId++,
          date: Math.floor(Date.now() / 1_000),
          chat: { id: Number(send.chat_id), type: "private", first_name: "Test" },
          ...(send.text ? { text: send.text } : {}),
          ...(send.rich_message ? { rich_message: send.rich_message } : {}),
        },
      } as never;
    }
    return { ok: true, result: true } as never;
  });
  return { bot, calls, logger };
}

function richCallbackData(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(richCallbackData);
  if (typeof value !== "object" || value === null) return [];
  const record = value as Record<string, unknown>;
  const current = typeof record.callback_data === "string" ? [record.callback_data] : [];
  return [...current, ...Object.values(record).flatMap(richCallbackData)];
}

function containsRichDocument(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsRichDocument);
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.type === "document" || Object.values(record).some(containsRichDocument);
}

function isDocumentCall(call: CapturedApiCall): boolean {
  return call.method === "sendDocument" ||
    (call.method === "sendRichMessage" && containsRichDocument(call.payload.rich_message));
}

describe("runtime configuration", () => {
  it("accepts only hierarchical PostgreSQL URLs and keeps the sole owner fixed", () => {
    const base = {
      BOT_TOKEN: "TEST_TOKEN_NOT_A_REAL_CREDENTIAL",
      DATABASE_URL: "postgresql://localhost:5432/iris_test",
    };
    expect(loadConfig({ ...base, OWNER_ID: "123456789" }).ownerId).toBe(OWNER_ID);
    expect(() => loadConfig({ ...base, DATABASE_URL: "https://localhost/iris" })).toThrow("valid PostgreSQL URL");
    expect(() => loadConfig({ ...base, DATABASE_URL: "postgresql:relative-path" })).toThrow("valid PostgreSQL URL");
    expect(() => loadConfig({ ...base, DATABASE_URL: "not-a-url" })).toThrow("valid PostgreSQL URL");
  });

  it("handles blank optional env vars with explicit development storage", () => {
    const cfg = loadConfig({
      BOT_TOKEN: "TEST_TOKEN_NOT_A_REAL_CREDENTIAL",
      DATABASE_URL: "",
      NODE_ENV: "development",
      LOG_LEVEL: "",
      BONUS_CREDITS: "",
      BONUS_PERIOD_HOURS: "",
      DATABASE_POOL_SIZE: "",
    });
    expect(cfg.databaseUrl).toBe("");
    expect(cfg.bonusCredits).toBe(25);
    expect(cfg.bonusPeriodHours).toBe(24);
    expect(cfg.databasePoolSize).toBe(10);
  });

  it.each([undefined, "", "   ", "postgresql://YOUR_DB_USER:YOUR_DB_PASSWORD@localhost:5432/iris"])(
    "rejects missing or placeholder production storage (%s)", (databaseUrl) => {
      expect(() => loadConfig({
        BOT_TOKEN: "TEST_TOKEN_NOT_A_REAL_CREDENTIAL",
        NODE_ENV: "production",
        DATABASE_URL: databaseUrl,
      })).toThrow("DATABASE_URL is required in production");
    },
  );

  it.each([undefined, "", "   "])("defaults a missing/blank environment to production safety (%s)", (environment) => {
    const base = { BOT_TOKEN: "TEST_TOKEN_NOT_A_REAL_CREDENTIAL", NODE_ENV: environment };
    expect(() => loadConfig(base)).toThrow("DATABASE_URL is required in production");
    expect(loadConfig({ ...base, DATABASE_URL: "postgresql://localhost:5432/iris" }).nodeEnv).toBe("production");
  });

  it("requires a real PostgreSQL URL in production while retaining explicit local/test storage", () => {
    expect(loadConfig({
      BOT_TOKEN: "TEST_TOKEN_NOT_A_REAL_CREDENTIAL",
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://localhost:5432/iris",
    })).toMatchObject({ nodeEnv: "production", databaseUrl: "postgresql://localhost:5432/iris" });
    for (const environment of ["development", "test"]) {
      expect(loadConfig({ BOT_TOKEN: "TEST_TOKEN_NOT_A_REAL_CREDENTIAL", NODE_ENV: environment }))
        .toMatchObject({ nodeEnv: environment, databaseUrl: "" });
    }
  });

  it("initializes an embedded PGlite database and schema automatically when DATABASE_URL is empty", async () => {
    const logger = {
      trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(),
    } as unknown as AppLogger;
    const db = createDatabase("", 5, logger, "test");
    try {
      await db.init?.();
      const count = await db.prisma.user.count();
      expect(count).toBeGreaterThanOrEqual(0);
      await expect(db.prisma.purchase.findMany()).resolves.toEqual([]);
    } finally {
      await db.close();
    }
  }, 30_000);
});

describe("Telegram command menu", () => {
  it("registers the HTTPS Mini App menu button without changing owner authorization", async () => {
    const { bot, calls, logger } = makeTestBot();
    await registerCommandMenus(bot.api, OWNER_ID, logger, "https://iris.example.test");
    expect(calls.find((call) => call.method === "setChatMenuButton")?.payload.menu_button).toEqual({
      type: "web_app", text: "Open Iris", web_app: { url: "https://iris.example.test" },
    });
  });
  it("opens a private-chat Mini App button from /app", async () => {
    const { bot, calls } = makeTestBot("https://iris.example.test");
    await bot.handleUpdate(privateMessageUpdate(61_040, "/app"));
    const message = calls.find((call) => call.method === "sendMessage" && call.payload.reply_markup);
    expect(JSON.stringify(message?.payload.reply_markup)).toContain('"web_app":{"url":"https://iris.example.test"}');
  });
  it("shows public commands plus /admin to everyone and overwrites the owner's legacy menu", async () => {
    const { bot, calls, logger } = makeTestBot();
    await registerCommandMenus(bot.api, OWNER_ID, logger);

    const registrations = calls.filter((call) => call.method === "setMyCommands");
    expect(registrations).toHaveLength(3);
    const names = registrations.map((call) =>
      (call.payload.commands as Array<{ command: string }>).map(({ command }) => command),
    );
    const expected = [...PUBLIC_COMMANDS.map(({ command }) => command), "admin"];
    expect(COMMAND_MENU.map(({ command }) => command)).toEqual(expected);
    expect(names).toEqual([expected, expected, expected]);
    for (const hiddenOwnerCommand of ["gift", "rm", "giftall", "code", "broadcast", "stats", "export", "addstock", "restart", "reset"]) {
      expect(names[0]).not.toContain(hiddenOwnerCommand);
    }
    expect(registrations[0]?.payload.scope).toEqual({ type: "default" });
    expect(registrations[1]?.payload.scope).toEqual({ type: "all_private_chats" });
    expect(registrations[2]?.payload.scope).toEqual({ type: "chat", chat_id: Number(OWNER_ID) });
  });
});

let testUpdateId = 1_000;
let testCallbackId = 1_000;

function privateMessageUpdate(telegramId: number, text: string): Update {
  const firstName = `Test ${telegramId}`;
  return {
    update_id: testUpdateId++,
    message: {
      message_id: testUpdateId,
      date: Math.floor(Date.now() / 1_000),
      chat: { id: telegramId, type: "private", first_name: firstName },
      from: { id: telegramId, is_bot: false, first_name: firstName },
      text,
      ...(text.startsWith("/")
        ? { entities: [{ offset: 0, length: text.split(/\s/, 1)[0]!.length, type: "bot_command" }] }
        : {}),
    },
  } as Update;
}

function privateCallbackUpdate(telegramId: number, data: string): Update {
  const firstName = `Test ${telegramId}`;
  return {
    update_id: testUpdateId++,
    callback_query: {
      id: `test-callback-${testCallbackId++}`,
      from: { id: telegramId, is_bot: false, first_name: firstName },
      chat_instance: `test-chat-${telegramId}`,
      message: {
        message_id: testUpdateId,
        date: Math.floor(Date.now() / 1_000),
        chat: { id: telegramId, type: "private", first_name: firstName },
        text: "Iris menu",
      },
      data,
    },
  } as Update;
}

beforeAll(async () => {
  const migrations = (await readdir(migrationsRoot)).filter((name) => /^\d/.test(name)).sort();
  const migrationSql = await Promise.all(migrations.map(async (name) => readFile(new URL(`${name}/migration.sql`, migrationsRoot), "utf8")));
  if (process.env.TEST_POSTGRES_URL) {
    // Never use the application's DATABASE_URL. Keep real PostgreSQL tests in a
    // unique schema so cleanup cannot delete pre-existing tables or store data.
    postgresSchema = `iris_test_${randomUUID().replaceAll("-", "")}`;
    const setupPool = new Pool({ connectionString: process.env.TEST_POSTGRES_URL });
    try {
      await setupPool.query(`CREATE SCHEMA "${postgresSchema}"`);
    } finally {
      await setupPool.end();
    }
    postgresPool = new Pool({
      connectionString: process.env.TEST_POSTGRES_URL,
      options: `-c search_path=${postgresSchema}`,
      max: 10,
    });
    const client = await postgresPool.connect();
    try {
      for (const sql of migrationSql) await client.query(sql);
    } finally {
      client.release();
    }
  } else {
    pg = new PGlite();
    for (const sql of migrationSql) await pg.exec(sql);
  }
  prisma = createTestClient();
  await prisma.$connect();
}, 60_000);

afterAll(async () => {
  try {
    await prisma?.$disconnect();
  } finally {
    if (postgresPool) {
      try {
        await postgresPool.query(`DROP SCHEMA IF EXISTS "${postgresSchema}" CASCADE`);
      } finally {
        await postgresPool.end();
      }
    }
    await pg?.close();
  }
}, 60_000);

beforeEach(async () => {
  await prisma.wishlistItem.deleteMany();
  await prisma.warrantyClaim.deleteMany();
  await prisma.stockSubscription.deleteMany();
  await prisma.purchase.deleteMany();
  await prisma.codeRedemption.deleteMany();
  await prisma.inventoryItem.deleteMany();
  await prisma.creditTransaction.deleteMany();
  await prisma.redeemCode.deleteMany();
  await prisma.product.deleteMany();
  await prisma.category.deleteMany();
  await prisma.user.deleteMany();
  await prisma.resetChallenge.deleteMany();
  await prisma.adminAudit.deleteMany();
  await prisma.appSetting.deleteMany();
});

describe("profiles, catalog, and inventory", () => {
  it("creates and updates a Telegram profile without resetting its balance", async () => {
    const input: TelegramUser = {
      id: 9_001,
      is_bot: false,
      first_name: "First",
      username: "iris_user",
    };
    const created = await touchUser(prisma, input);
    await prisma.user.update({ where: { id: created.id }, data: { credits: 60 } });
    const updated = await touchUser(prisma, { ...input, first_name: "Updated", last_name: "Name", username: "iris_updated" });

    expect(updated.id).toBe(created.id);
    expect(updated).toMatchObject({
      telegramId: 9_001n,
      username: "iris_updated",
      firstName: "Updated",
      lastName: "Name",
      credits: 60,
    });
    expect(await prisma.user.count()).toBe(1);
  });

  it("creates, updates, reorders, disables, and archives categories and products", async () => {
    const first = await createCategory(prisma, { name: "First category" });
    const second = await createCategory(prisma, { name: "Second category" });
    const product = await createProduct(prisma, {
      categoryId: first.id,
      name: "Catalog item",
      description: "Original description",
      price: 40,
    });
    const edited = await updateProduct(prisma, product.id, {
      name: "Updated item",
      description: "Updated description",
      price: 55,
      emoji: "⭐",
      categoryId: second.id,
    });
    expect(edited).toMatchObject({
      name: "Updated item",
      description: "Updated description",
      price: 55,
      emoji: "⭐",
      categoryId: second.id,
    });

    const renamed = await updateCategory(prisma, first.id, { name: "Renamed category", description: "Updated" });
    expect(renamed).toMatchObject({ name: "Renamed category", description: "Updated" });
    await reorderCategory(prisma, second.id, -1);
    const ordered = await prisma.category.findMany({ orderBy: { displayOrder: "asc" } });
    expect(ordered[0]?.id).toBe(second.id);

    await updateProduct(prisma, product.id, { enabled: false });
    expect(await listEnabledCategories(prisma)).toHaveLength(2);
    expect((await listCategoryProducts(prisma, second.id)).products).toHaveLength(0);
    await archiveCategory(prisma, second.id);
    const archived = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(archived).toMatchObject({ enabled: false, deletedAt: expect.any(Date) });
    await expect(archiveProduct(prisma, product.id)).rejects.toBeDefined();
    expect(await listEnabledCategories(prisma)).toHaveLength(1);
  });

  it("stores only https web image links, clears them on request, and copies them when cloning", async () => {
    const category = await createCategory(prisma, { name: "Artwork category" });
    const product = await createProduct(prisma, {
      categoryId: category.id,
      name: "Artwork item",
      price: 30,
      imageUrl: "  https://cdn.example.com/art/pack.png  ",
    });
    expect(product.imageUrl).toBe("https://cdn.example.com/art/pack.png");

    const edited = await updateProduct(prisma, product.id, { imageUrl: "https://cdn.example.com/art/other.webp" });
    expect(edited.imageUrl).toBe("https://cdn.example.com/art/other.webp");
    // Local development may point at the developer's own machine, where there is no TLS to enforce.
    expect((await updateProduct(prisma, product.id, { imageUrl: "http://localhost:5173/art.png" })).imageUrl).toBe("http://localhost:5173/art.png");

    for (const rejected of [
      "not a link",
      "http://cdn.example.com/art.png",
      "javascript:alert(1)",
      "//cdn.example.com/a.png",
      "ftp://cdn.example.com/a.png",
      `https://cdn.example.com/${"a".repeat(1_100)}.png`,
    ]) {
      await expect(updateProduct(prisma, product.id, { imageUrl: rejected })).rejects.toBeDefined();
    }
    expect((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).imageUrl).toBe("http://localhost:5173/art.png");

    const clone = await cloneProduct(prisma, product.id);
    expect(clone.imageUrl).toBe("http://localhost:5173/art.png");

    expect((await updateProduct(prisma, product.id, { imageUrl: null })).imageUrl).toBeNull();
    expect((await updateProduct(prisma, product.id, { imageUrl: "   " })).imageUrl).toBeNull();
  });

  it("collects a web image link in the add-product wizard and refuses an insecure one", async () => {
    const category = await createCategory(prisma, { name: "Wizard category" });
    const { bot } = makeTestBot();
    const send = (text: string) => bot.handleUpdate(privateMessageUpdate(Number(OWNER_ID), text));

    await bot.handleUpdate(privateCallbackUpdate(Number(OWNER_ID), `admin:product:add:${category.id}`));
    await send("Wizard product");
    await send("A tidy little upgrade");
    await send("120");
    await send("🎁");
    // An insecure link is refused and must not create the product either.
    await send("http://insecure.example.com/art.png");
    expect(await prisma.product.count()).toBe(0);
    await send("https://cdn.example.com/art/wizard.png");

    const product = await prisma.product.findFirstOrThrow({ where: { name: "Wizard product" } });
    expect(product).toMatchObject({
      categoryId: category.id, price: 120, emoji: "🎁",
      description: "A tidy little upgrade", imageUrl: "https://cdn.example.com/art/wizard.png",
    });

    // Skipping the final step still creates the product, falling back to the branded tile.
    await bot.handleUpdate(privateCallbackUpdate(Number(OWNER_ID), `admin:product:add:${category.id}`));
    await send("Second wizard product");
    await send("/skip");
    await send("45");
    await send("/skip");
    await send("/skip");
    const skipped = await prisma.product.findFirstOrThrow({ where: { name: "Second wizard product" } });
    expect(skipped).toMatchObject({ price: 45, emoji: "✦", description: "", imageUrl: null });
  });

  it("lets the owner set, refuse, and clear a product's web image from the admin panel", async () => {
    const { product } = await makeProduct("Artwork product", 25);
    const { bot, calls } = makeTestBot();
    const stored = async () => (await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).imageUrl;
    const openEditor = () => bot.handleUpdate(privateCallbackUpdate(Number(OWNER_ID), `admin:product:edit:image:${product.id}`));

    await openEditor();
    await bot.handleUpdate(privateMessageUpdate(Number(OWNER_ID), "https://cdn.example.com/art/pack.png"));
    expect(await stored()).toBe("https://cdn.example.com/art/pack.png");
    const panel = JSON.stringify([...calls].reverse().find((call) => call.method === "sendRichMessage")?.payload);
    expect(panel).toContain(`admin:product:edit:image:${product.id}`);
    expect(panel).toContain(smallCaps("Set 🌐"));
    expect(panel).not.toContain(smallCaps("None (branded tile)"));

    // An insecure link is refused and the value already stored is left untouched.
    await openEditor();
    await bot.handleUpdate(privateMessageUpdate(Number(OWNER_ID), "http://insecure.example.com/art.png"));
    expect(await stored()).toBe("https://cdn.example.com/art/pack.png");

    await openEditor();
    await bot.handleUpdate(privateMessageUpdate(Number(OWNER_ID), "/skip"));
    expect(await stored()).toBeNull();
  });

  it("keeps inventory tied to one product and updates available stock accurately", async () => {
    const user = await makeUser(9_002n, 10);
    const { product } = await makeProduct("Stock lifecycle", 5);
    const added = await addInventoryItems(prisma, product.id, ["first-secret", "second-secret"]);
    expect(added).toEqual({ inserted: 2, duplicates: 0 });
    expect(await countAvailableInventory(prisma, product.id)).toBe(2);

    const available = await listAvailableInventory(prisma, product.id);
    expect(available).toHaveLength(2);
    expect(available.every((item) => item.productId === product.id)).toBe(true);
    expect(available[0]).not.toHaveProperty("payload");
    await removeInventoryItem(prisma, available[0]!.id);
    expect(await countAvailableInventory(prisma, product.id)).toBe(1);

    const result = await purchaseProduct(prisma, user.id, product.id, "purchase:stock-lifecycle");
    const purchase = await prisma.purchase.findUniqueOrThrow({ where: { id: result.purchaseId } });
    const soldItem = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: purchase.inventoryItemId } });
    expect(purchase).toMatchObject({ buyerId: user.id, productId: product.id, inventoryItemId: soldItem.id });
    expect(soldItem).toMatchObject({ status: "SOLD", purchaserId: user.id, productId: product.id });
    expect(soldItem.purchasedAt).toBeInstanceOf(Date);
    expect(await countAvailableInventory(prisma, product.id)).toBe(0);
    await expect(removeInventoryItem(prisma, soldItem.id)).rejects.toBeDefined();
  });
});

describe("transaction-safe purchases", () => {
  it("charges once, keeps a private delivery, and returns the same order on replay", async () => {
    const user = await makeUser(10_001n, 100);
    const { product } = await makeProduct("License", 50);
    await addInventoryItems(prisma, product.id, ["private-license-value"]);

    const first = await purchaseProduct(prisma, user.id, product.id, "purchase:once");
    const replay = await purchaseProduct(prisma, user.id, product.id, "purchase:once");

    expect(first).toMatchObject({ paid: 50, remainingCredits: 50, payload: "private-license-value", repeated: false });
    expect(replay).toMatchObject({ purchaseId: first.purchaseId, payload: first.payload, repeated: true });
    expect(await prisma.purchase.count()).toBe(1);
    expect(await prisma.inventoryItem.count({ where: { status: "AVAILABLE" } })).toBe(0);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).credits).toBe(50);
    expect(await prisma.creditTransaction.count({ where: { type: "PURCHASE", amount: -50 } })).toBe(1);
    const otherUser = await makeUser(10_005n, 100);
    await expect(purchaseProduct(prisma, otherUser.id, product.id, "purchase:once")).rejects.toBeInstanceOf(ValidationError);
    await expect(purchaseProduct(prisma, user.id, product.id, "purchase:another")).rejects.toBeInstanceOf(OutOfStockError);
  });

  it("replays every bulk item and its original price through a fresh database client", async () => {
    const buyer = await makeUser(10_020n, 500);
    const { product } = await makeProduct("Bulk replay", 40);
    await addInventoryItems(prisma, product.id, ["bulk-one", "bulk-two", "bulk-three"]);
    const first = await purchaseProduct(prisma, buyer.id, product.id, "purchase:bulk-replay", 40, 3);
    await updateProduct(prisma, product.id, { price: 99, enabled: false });

    const newClient = createTestClient();
    try {
      // Neither a new client nor a changed quantity/price may alter a committed checkout.
      const replay = await purchaseProduct(newClient, buyer.id, product.id, "purchase:bulk-replay", 99, 1);
      expect(replay).toEqual({ ...first, repeated: true });
      expect(purchaseDeliveryMessage(replay)).toContain("× 3");
      for (const payload of first.payloads) expect(purchaseDeliveryMessage(replay)).toContain(payload);
    } finally {
      await newClient.$disconnect();
    }
    expect(await prisma.purchase.count()).toBe(3);
    expect(await prisma.creditTransaction.count({ where: { type: "PURCHASE", amount: -120 } })).toBe(1);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: buyer.id } })).credits).toBe(380);
    expect(await countAvailableInventory(prisma, product.id)).toBe(0);
  });

  it.each([126, 127, 128])("supports %i-character bulk request keys without truncation collisions", async (length) => {
    const buyer = await makeUser(10_021n, 500);
    const { product } = await makeProduct("Long request key", 20);
    await addInventoryItems(prisma, product.id, ["long-key-one", "long-key-two", "long-key-three"]);
    const key = "k".repeat(length);
    const first = await purchaseProduct(prisma, buyer.id, product.id, key, 20, 3);
    const replay = await purchaseProduct(prisma, buyer.id, product.id, key);
    expect(replay).toEqual({ ...first, repeated: true });
    expect(first).toMatchObject({ quantity: 3, paid: 60, remainingCredits: 440 });
    const rows = await prisma.purchase.findMany({ orderBy: { batchIndex: "asc" } });
    expect(rows.map((row) => row.batchId)).toEqual([first.purchaseId, first.purchaseId, first.purchaseId]);
    expect(rows.map((row) => row.batchIndex)).toEqual([0, 1, 2]);
    expect(new Set(rows.map((row) => row.idempotencyKey)).size).toBe(3);
    expect(rows.every((row) => row.idempotencyKey.length <= 128)).toBe(true);
    expect(await prisma.creditTransaction.count({ where: { type: "PURCHASE" } })).toBe(1);
  });

  it("recovers the complete committed bulk delivery after a transaction error", async () => {
    const buyer = await makeUser(10_022n, 500);
    const { product } = await makeProduct("Lost bulk response", 30);
    await addInventoryItems(prisma, product.id, ["lost-one", "lost-two", "lost-three"]);
    const first = await purchaseProduct(prisma, buyer.id, product.id, "purchase:lost-response", 30, 3);
    const transaction = vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(new Error("Simulated lost response"));
    try {
      const replay = await purchaseProduct(prisma, buyer.id, product.id, "purchase:lost-response", 30, 3);
      expect(replay).toEqual({ ...first, repeated: true });
    } finally {
      transaction.mockRestore();
    }
    expect(await prisma.purchase.count()).toBe(3);
    expect(await prisma.creditTransaction.count({ where: { type: "PURCHASE" } })).toBe(1);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: buyer.id } })).credits).toBe(410);
  });

  it("serializes concurrent duplicate bulk requests without extra charges or stock allocation", async () => {
    const buyer = await makeUser(10_023n, 500);
    const { product } = await makeProduct("Concurrent bulk retry", 40);
    await addInventoryItems(prisma, product.id, ["concurrent-one", "concurrent-two", "concurrent-three"]);
    const results = await Promise.all(Array.from({ length: 3 }, () =>
      purchaseProduct(prisma, buyer.id, product.id, "purchase:concurrent-bulk", 40, 3)));
    expect(new Set(results.map((result) => result.purchaseId)).size).toBe(1);
    expect(results.filter((result) => !result.repeated)).toHaveLength(1);
    for (const result of results) {
      expect(result).toMatchObject({ quantity: 3, paid: 120, remainingCredits: 380 });
      expect(result.payloads).toEqual(results[0]!.payloads);
    }
    expect(await prisma.purchase.count()).toBe(3);
    expect(await prisma.creditTransaction.count({ where: { type: "PURCHASE" } })).toBe(1);
    expect(await countAvailableInventory(prisma, product.id)).toBe(0);
  });

  it("rejects bulk request keys reused by another buyer, product, or internal item", async () => {
    const buyer = await makeUser(10_024n, 500);
    const otherBuyer = await makeUser(10_025n, 500);
    const { product } = await makeProduct("Private bulk retry", 25);
    const { product: otherProduct } = await makeProduct("Different checkout", 10);
    await addInventoryItems(prisma, product.id, ["private-one", "private-two"]);
    await purchaseProduct(prisma, buyer.id, product.id, "purchase:private-bulk", 25, 2);
    const child = await prisma.purchase.findFirstOrThrow({ where: { batchIndex: 1 } });
    await expect(purchaseProduct(prisma, otherBuyer.id, product.id, "purchase:private-bulk"))
      .rejects.toBeInstanceOf(ValidationError);
    await expect(purchaseProduct(prisma, buyer.id, otherProduct.id, "purchase:private-bulk"))
      .rejects.toBeInstanceOf(ValidationError);
    await expect(purchaseProduct(prisma, buyer.id, product.id, child.idempotencyKey))
      .rejects.toBeInstanceOf(ValidationError);
    expect(await prisma.purchase.count()).toBe(2);
    expect(await prisma.creditTransaction.count({ where: { type: "PURCHASE" } })).toBe(1);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: otherBuyer.id } })).credits).toBe(500);
  });

  it("replays free bulk purchases without inferring quantity from their price", async () => {
    const buyer = await makeUser(10_026n);
    const { product } = await makeProduct("Free bulk delivery", 0);
    await addInventoryItems(prisma, product.id, ["free-one", "free-two", "free-three"]);
    const first = await purchaseProduct(prisma, buyer.id, product.id, "purchase:free-bulk", 0, 3);
    expect(await purchaseProduct(prisma, buyer.id, product.id, "purchase:free-bulk"))
      .toEqual({ ...first, repeated: true });
    expect(first).toMatchObject({ quantity: 3, paid: 0, remainingCredits: 0 });
    expect(await prisma.creditTransaction.count({ where: { type: "PURCHASE", amount: 0 } })).toBe(1);
  });

  it("does not partially fulfill a bulk checkout with insufficient stock or credits", async () => {
    const buyer = await makeUser(10_027n, 20);
    const { product } = await makeProduct("Atomic bulk checkout", 25);
    await addInventoryItems(prisma, product.id, ["atomic-one", "atomic-two"]);
    await expect(purchaseProduct(prisma, buyer.id, product.id, "purchase:too-many", 25, 3))
      .rejects.toBeInstanceOf(OutOfStockError);
    await expect(purchaseProduct(prisma, buyer.id, product.id, "purchase:too-expensive", 25, 2))
      .rejects.toBeInstanceOf(InsufficientCreditsError);
    expect(await prisma.purchase.count()).toBe(0);
    expect(await prisma.creditTransaction.count()).toBe(0);
    expect(await countAvailableInventory(prisma, product.id)).toBe(2);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: buyer.id } })).credits).toBe(20);
  });

  it("rejects a stale price confirmation without charging or reserving stock", async () => {
    const user = await makeUser(10_008n, 100);
    const { product } = await makeProduct("Price-change item", 50);
    await addInventoryItems(prisma, product.id, ["still-private"]);
    await prisma.product.update({ where: { id: product.id }, data: { price: 75 } });

    await expect(purchaseProduct(prisma, user.id, product.id, "purchase:stale-price", 50))
      .rejects.toBeInstanceOf(PriceChangedError);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).credits).toBe(100);
    expect(await countAvailableInventory(prisma, product.id)).toBe(1);
    expect(await prisma.purchase.count()).toBe(0);
    expect(await prisma.creditTransaction.count()).toBe(0);
  });

  it("assigns distinct stock under concurrent purchases and never oversells", async () => {
    const firstUser = await makeUser(10_002n, 100);
    const secondUser = await makeUser(10_003n, 100);
    const { product } = await makeProduct("Concurrent license", 50);
    await addInventoryItems(prisma, product.id, ["payload-one", "payload-two"]);

    const results = await Promise.all([
      purchaseProduct(prisma, firstUser.id, product.id, "purchase:first"),
      purchaseProduct(prisma, secondUser.id, product.id, "purchase:second"),
    ]);

    expect(new Set(results.map((result) => result.payload))).toEqual(new Set(["payload-one", "payload-two"]));
    expect(results.every((result) => !result.repeated)).toBe(true);
    expect(await prisma.purchase.count()).toBe(2);
    expect(await prisma.inventoryItem.count({ where: { status: "AVAILABLE" } })).toBe(0);
    expect(await prisma.creditTransaction.count({ where: { type: "PURCHASE" } })).toBe(2);
  });

  it("lets only one buyer claim the final inventory unit", async () => {
    const firstUser = await makeUser(10_006n, 100);
    const secondUser = await makeUser(10_007n, 100);
    const { product } = await makeProduct("Last unit", 50);
    await addInventoryItems(prisma, product.id, ["single-private-value"]);

    const attempts = await Promise.allSettled([
      purchaseProduct(prisma, firstUser.id, product.id, "purchase:last:first"),
      purchaseProduct(prisma, secondUser.id, product.id, "purchase:last:second"),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const failure = attempts.find((attempt) => attempt.status === "rejected");
    expect(failure?.status).toBe("rejected");
    if (failure?.status === "rejected") expect(failure.reason).toBeInstanceOf(OutOfStockError);
    expect(await prisma.purchase.count()).toBe(1);
    expect(await prisma.creditTransaction.count({ where: { type: "PURCHASE" } })).toBe(1);
    expect(await prisma.user.aggregate({ _sum: { credits: true } })).toMatchObject({ _sum: { credits: 150 } });
  });

  it("hashes long stock values for safe deduplication and enforces Telegram delivery size", async () => {
    const { product } = await makeProduct("Long key", 0);
    const payload = "K".repeat(3_500);
    const result = await addInventoryItems(prisma, product.id, [payload, payload]);

    expect(result).toEqual({ inserted: 1, duplicates: 1 });
    expect((await prisma.inventoryItem.findFirstOrThrow({ where: { productId: product.id } })).payloadHash).toHaveLength(64);
    await expect(addInventoryItems(prisma, product.id, [payload])).resolves.toEqual({ inserted: 0, duplicates: 1 });
    await expect(addInventoryItems(prisma, product.id, ["K".repeat(3_501)])).rejects.toBeInstanceOf(ValidationError);
  });

  it("rolls back stock assignment and ledger writes when the buyer cannot afford it", async () => {
    const user = await makeUser(10_004n, 5);
    const { product } = await makeProduct("Expensive item", 50);
    await addInventoryItems(prisma, product.id, ["still-available"]);

    await expect(purchaseProduct(prisma, user.id, product.id, "purchase:poor")).rejects.toBeInstanceOf(InsufficientCreditsError);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).credits).toBe(5);
    expect(await prisma.inventoryItem.count({ where: { status: "AVAILABLE" } })).toBe(1);
    expect(await prisma.purchase.count()).toBe(0);
    expect(await prisma.creditTransaction.count()).toBe(0);
  });
});

describe("credits, bonuses, and redeem codes", () => {
  it("permits exactly one concurrent daily bonus and records the balance atomically", async () => {
    const user = await makeUser(20_001n);
    const claims = await Promise.allSettled([
      claimDailyBonus(prisma, user.id, 25, 24),
      claimDailyBonus(prisma, user.id, 25, 24),
    ]);

    expect(claims.filter((claim) => claim.status === "fulfilled")).toHaveLength(1);
    const failure = claims.find((claim) => claim.status === "rejected");
    expect(failure?.status).toBe("rejected");
    if (failure?.status === "rejected") expect(failure.reason).toBeInstanceOf(BonusUnavailableError);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).credits).toBe(25);
    expect(await prisma.creditTransaction.count({ where: { type: "BONUS" } })).toBe(1);
  });

  it("enforces per-user and total redemption limits without duplicate credit", async () => {
    const user = await makeUser(20_002n);
    const secondUser = await makeUser(20_003n);
    const [code] = await createRedeemCodes(prisma, {
      amount: 1,
      credits: 40,
      maxRedeems: 1,
      createdBy: OWNER_ID,
    });
    expect(code).toBeDefined();

    const first = await redeemCode(prisma, user.id, code!);
    expect(first).toMatchObject({ credits: 40, balance: 40, code });
    await expect(redeemCode(prisma, user.id, code!)).rejects.toBeInstanceOf(AlreadyRedeemedError);
    await expect(redeemCode(prisma, secondUser.id, code!)).rejects.toBeInstanceOf(CodeUnavailableError);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).credits).toBe(40);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: secondUser.id } })).credits).toBe(0);
    expect(await prisma.codeRedemption.count()).toBe(1);
    expect(await prisma.creditTransaction.count({ where: { type: "REDEEM" } })).toBe(1);
  });

  it("does not let concurrent users exceed a redeem code's configured limit", async () => {
    const firstUser = await makeUser(20_008n);
    const secondUser = await makeUser(20_009n);
    const [code] = await createRedeemCodes(prisma, {
      amount: 1,
      credits: 30,
      maxRedeems: 1,
      createdBy: OWNER_ID,
    });

    const attempts = await Promise.allSettled([
      redeemCode(prisma, firstUser.id, code!),
      redeemCode(prisma, secondUser.id, code!),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const failed = attempts.find((attempt) => attempt.status === "rejected");
    expect(failed?.status).toBe("rejected");
    if (failed?.status === "rejected") expect(failed.reason).toBeInstanceOf(CodeUnavailableError);
    expect((await prisma.redeemCode.findUniqueOrThrow({ where: { code: code! } })).currentRedeems).toBe(1);
    expect(await prisma.codeRedemption.count()).toBe(1);
    expect(await prisma.creditTransaction.count({ where: { type: "REDEEM" } })).toBe(1);
    expect(await prisma.user.aggregate({ _sum: { credits: true } })).toMatchObject({ _sum: { credits: 30 } });
  });

  it("limits gifts to active users and refuses negative or over-limit balances", async () => {
    const active = await makeUser(20_004n, 10, new Date());
    const inactive = await makeUser(20_005n, 10, new Date(Date.now() - 73 * 60 * 60 * 1_000));
    const nearLimit = await makeUser(20_006n, MAX_CREDITS - 1, new Date());

    const gift = await giftAllActiveUsers(prisma, 5, 72);
    expect(gift.recipients).toBe(1);
    expect(gift.skipped).toBe(1);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: active.id } })).credits).toBe(15);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: inactive.id } })).credits).toBe(10);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: nearLimit.id } })).credits).toBe(MAX_CREDITS - 1);
    expect(await prisma.creditTransaction.count({ where: { type: "GIFT_ALL", batchId: gift.batchId } })).toBe(1);

    await expect(changeCredits(prisma, { userId: active.id, amount: -100, type: "ADMIN_ADJUSTMENT", description: "test" }))
      .rejects.toBeInstanceOf(InsufficientCreditsError);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: active.id } })).credits).toBe(15);
  });

  it("records successful admin credit additions and removals in the ledger", async () => {
    const user = await makeUser(20_007n, 20);
    const gift = await giftCredits(prisma, user.telegramId, 50);
    expect(gift.credits).toBe(70);
    const removed = await removeCredits(prisma, user.telegramId, 15);
    expect(removed.credits).toBe(55);

    const ledger = await prisma.creditTransaction.findMany({ where: { userId: user.id } });
    expect(ledger).toHaveLength(2);
    expect(ledger).toEqual(expect.arrayContaining([
      expect.objectContaining({ amount: 50, type: "GIFT", balanceAfter: 70 }),
      expect.objectContaining({ amount: -15, type: "ADMIN_ADJUSTMENT", balanceAfter: 55 }),
    ]));
    await expect(removeCredits(prisma, user.telegramId, 100)).rejects.toBeInstanceOf(InsufficientCreditsError);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).credits).toBe(55);
    expect(await prisma.creditTransaction.count({ where: { userId: user.id } })).toBe(2);
  });

  it("lists each user's credit ledger newest-first with bounded pagination", async () => {
    const user = await makeUser(20_010n);
    const otherUser = await makeUser(20_011n);
    const baseTime = Date.now();
    await prisma.creditTransaction.createMany({
      data: Array.from({ length: 5 }, (_, index) => ({
        id: `wallet-ledger-${index}`,
        userId: user.id,
        amount: index % 2 === 0 ? 10 : -5,
        type: index % 2 === 0 ? "BONUS" as const : "PURCHASE" as const,
        description: `activity ${index}`,
        balanceAfter: 50 + index,
        createdAt: new Date(baseTime + index * 1_000),
      })),
    });
    await prisma.creditTransaction.create({
      data: {
        id: "wallet-other-user",
        userId: otherUser.id,
        amount: 99,
        type: "GIFT",
        description: "private to another user",
        balanceAfter: 99,
      },
    });

    const firstPage = await listUserCreditTransactions(prisma, user.id, 0, 2);
    expect(firstPage).toMatchObject({ total: 5, page: 0, pages: 3 });
    expect(firstPage.transactions.map((entry) => entry.description)).toEqual(["activity 4", "activity 3"]);

    const secondPage = await listUserCreditTransactions(prisma, user.id, 1, 2);
    expect(secondPage.transactions.map((entry) => entry.description)).toEqual(["activity 2", "activity 1"]);

    const outOfRangePage = await listUserCreditTransactions(prisma, user.id, 100, 2);
    expect(outOfRangePage).toMatchObject({ page: 2, pages: 3 });
    expect(outOfRangePage.transactions.map((entry) => entry.description)).toEqual(["activity 0"]);
    expect(JSON.stringify(firstPage)).not.toContain("private to another user");
  });

  it("updates bonus settings transactionally and reads them back", async () => {
    await updateBonusSettings(prisma, { credits: 80, periodHours: 48 });
    await expect(getBonusSettings(prisma, { credits: 25, periodHours: 24 })).resolves.toEqual({ credits: 80, periodHours: 48 });
    await expect(updateBonusSettings(prisma, { credits: 0, periodHours: 48 })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("exports and confirmed resets", () => {
  it("exports recoverable business data and only resets after the second confirmation", async () => {
    const user = await makeUser(30_001n);
    const { product } = await makeProduct("Backup item", 20);
    await addInventoryItems(prisma, product.id, ["backup-payload"]);
    await changeCredits(prisma, { userId: user.id, amount: 100, type: "GIFT", description: "test gift" });
    const [code] = await createRedeemCodes(prisma, {
      amount: 1,
      credits: 10,
      maxRedeems: 1,
      createdBy: OWNER_ID,
    });
    await redeemCode(prisma, user.id, code!);
    const order = await purchaseProduct(prisma, user.id, product.id, "purchase:backup");
    await updateBonusSettings(prisma, { credits: 30, periodHours: 24 });
    await prisma.adminAudit.create({ data: { ownerTelegramId: OWNER_ID, action: "TEST_BEFORE_RESET" } });

    const backup = await buildStoreExport(prisma);
    expect(backup.format).toBe("iris-store-export-v2");
    expect(backup.users[0]?.telegramId).toBe("30001");
    expect(backup.inventory[0]?.payload).toBe("backup-payload");
    expect(backup.redeemCodes[0]?.createdBy).toBe(OWNER_ID.toString());
    expect(backup.codeRedemptions).toHaveLength(1);
    expect(backup.creditTransactions).toHaveLength(3);
    expect(backup.purchases).toHaveLength(1);
    expect(backup.purchases[0]).toMatchObject({
      id: order.purchaseId,
      idempotencyKey: "purchase:backup",
      batchId: order.purchaseId,
      batchIndex: 0,
    });
    expect(() => JSON.stringify(backup)).not.toThrow();

    const challenge = await createResetChallenge(prisma, OWNER_ID);
    const storedChallenge = await prisma.resetChallenge.findUniqueOrThrow({ where: { id: challenge.id } });
    expect(storedChallenge.tokenHash).not.toBe(challenge.token);
    await expect(performConfirmedReset(prisma, challenge.id, challenge.token, OWNER_ID)).rejects.toBeInstanceOf(ValidationError);
    expect(await prisma.user.count()).toBe(1);

    await advanceResetChallenge(prisma, challenge.id, challenge.token, OWNER_ID);
    await expect(advanceResetChallenge(prisma, challenge.id, challenge.token, OWNER_ID)).rejects.toBeInstanceOf(ValidationError);
    const deleted = await performConfirmedReset(prisma, challenge.id, challenge.token, OWNER_ID);
    expect(deleted).toMatchObject({ users: 1, categories: 1, products: 1, inventory: 1, purchases: 1, redeemCodes: 1, redemptions: 1, creditTransactions: 3 });
    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.category.count()).toBe(0);
    expect(await prisma.purchase.count()).toBe(0);
    expect(await prisma.codeRedemption.count()).toBe(0);
    expect(await prisma.creditTransaction.count()).toBe(0);
    expect(await prisma.appSetting.count()).toBe(2);
    expect(await prisma.adminAudit.count()).toBe(2);
    expect((await prisma.adminAudit.findFirst({ where: { action: "RESET_COMPLETED" } }))?.details).toMatchObject({ users: 1 });
    expect((await prisma.resetChallenge.findUniqueOrThrow({ where: { id: challenge.id } })).usedAt).toBeInstanceOf(Date);
  });
  it("rejects expired and cancelled reset confirmations without deleting data", async () => {
    await makeUser(30_002n);
    const expired = await createResetChallenge(prisma, OWNER_ID);
    await prisma.resetChallenge.update({
      where: { id: expired.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    await expect(advanceResetChallenge(prisma, expired.id, expired.token, OWNER_ID)).rejects.toBeInstanceOf(ValidationError);
    await expect(performConfirmedReset(prisma, expired.id, expired.token, OWNER_ID)).rejects.toBeInstanceOf(ValidationError);
    expect(await prisma.user.count()).toBe(1);

    const cancelled = await createResetChallenge(prisma, OWNER_ID);
    await cancelResetChallenge(prisma, cancelled.id, OWNER_ID);
    await expect(advanceResetChallenge(prisma, cancelled.id, cancelled.token, OWNER_ID)).rejects.toBeInstanceOf(ValidationError);
    await expect(performConfirmedReset(prisma, cancelled.id, cancelled.token, OWNER_ID)).rejects.toBeInstanceOf(ValidationError);
    expect(await prisma.user.count()).toBe(1);
    expect((await prisma.resetChallenge.findUniqueOrThrow({ where: { id: cancelled.id } })).usedAt).toBeInstanceOf(Date);
  });
});

describe("broadcast and HTML output", () => {
  it("counts deliveries and marks users who blocked the bot", async () => {
    await prisma.user.create({ data: { id: "a", telegramId: 40_001n } });
    await prisma.user.create({ data: { id: "b", telegramId: 40_002n } });
    await prisma.user.create({ data: { id: "c", telegramId: 40_003n, isBlocked: true } });
    const sendMessage = vi.fn(async (chatId: number | string) => {
      if (chatId === 40_002) {
        throw new GrammyError("Forbidden", { ok: false, error_code: 403, description: "Forbidden" }, "sendMessage", {});
      }
      return {};
    });
    const progressUpdates: Array<{ processed: number; total: number; delivered: number; failed: number }> = [];

    const result = await broadcastToUsers(
      prisma,
      { sendMessage } as unknown as Api,
      "A store update",
      async (progress) => { progressUpdates.push(progress); },
    );

    expect(result).toEqual({ processed: 2, total: 2, delivered: 1, failed: 1 });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: "b" } })).toMatchObject({ isBlocked: true });
    expect(progressUpdates.at(-1)).toEqual(result);
  });

  it("escapes user names and digital inventory in Telegram HTML", () => {
    expect(welcomeMessage("<b>Alice</b>")).toContain("&lt;b&gt;Alice&lt;/b&gt;");
    expect(welcomeMessage("<b>Alice</b>")).not.toContain("<b>Alice</b>");
    expect(purchaseDeliveryMessage({
      purchaseId: "purchase-1",
      productName: "Item",
      productEmoji: "✦",
      paid: 1,
      remainingCredits: 0,
      payload: "</pre><b>private</b>",
      payloads: ["</pre><b>private</b>"],
      quantity: 1,
      repeated: false,
    })).toContain("&lt;/pre&gt;&lt;b&gt;private&lt;/b&gt;");
  });
});

describe("Telegram authorization and callback ownership", () => {
  it("blocks every owner command for another Telegram ID", async () => {
    const victim = await makeUser(77_001n, 125);
    const attackerId = 77_002;
    const { bot, calls } = makeTestBot();
    const commands = [
      "/admin",
      `/gift ${victim.telegramId} 90`,
      `/rm ${victim.telegramId} 10`,
      "/giftall 5",
      "/code 1 10 1",
      "/broadcast unauthorized",
      "/stats",
      "/export",
      "/restart",
      "/reset",
    ];

    for (const text of commands) await bot.handleUpdate(privateMessageUpdate(attackerId, text));

    expect((await prisma.user.findUniqueOrThrow({ where: { id: victim.id } })).credits).toBe(125);
    expect(await prisma.creditTransaction.count()).toBe(0);
    expect(await prisma.category.count()).toBe(0);
    expect(await prisma.resetChallenge.count()).toBe(0);
    const deniedReplies = calls
      .filter((call) => call.method === "sendMessage" || call.method === "sendRichMessage")
      .map((call) => JSON.stringify(call.payload.rich_message ?? call.payload.text));
    expect(deniedReplies).toHaveLength(commands.length);
    expect(deniedReplies.every((text) => text.includes("ʀᴇꜱᴇʀᴠᴇᴅ ꜰᴏʀ ᴛʜᴇ ɪʀɪꜱ ᴏᴡɴᴇʀ"))).toBe(true);
    expect(calls.some((call) => call.method.startsWith("editMessage"))).toBe(false);
  });

  it("renders the owner panel as a sectioned Bot API 10.3 rich dashboard", async () => {
    const { bot, calls } = makeTestBot();
    await bot.handleUpdate(privateMessageUpdate(Number(OWNER_ID), "/admin"));

    const panelCall = calls.find((call) => call.method === "sendRichMessage");
    expect(panelCall).toBeDefined();
    expect(JSON.stringify(panelCall?.payload.rich_message)).toContain("ᴏᴡɴᴇʀ ᴄᴏɴꜱᴏʟᴇ");
    const actions = richCallbackData(panelCall?.payload.rich_message);
    for (const data of [
      "admin:products:0",
      "admin:categories",
      "admin:inventory",
      "admin:users:0",
      "admin:purchases:0",
      "admin:warranty:0",
      "admin:stats",
      "admin:export",
      "admin:settings",
      "admin:restart",
      "admin:reset",
      "nav:home",
    ]) {
      expect(actions).toContain(data);
    }
  });

  it("rejects forged admin, inventory, user, and reset callbacks from non-owners", async () => {
    const victim = await makeUser(77_003n, 80);
    const { category, product } = await makeProduct("Protected item", 10);
    await addInventoryItems(prisma, product.id, ["never-delete-this"]);
    const stock = await prisma.inventoryItem.findFirstOrThrow({ where: { productId: product.id } });
    const reset = await createResetChallenge(prisma, OWNER_ID);
    const attackerId = 77_004;
    const { bot, calls } = makeTestBot();
    const forgedCallbacks = [
      "admin:panel",
      `admin:category:deleteconfirm:${category.id}`,
      `admin:product:deleteconfirm:${product.id}`,
      `admin:stock:removeconfirm:${stock.id}`,
      `admin:user:gift:${victim.id}:100`,
      `admin:user:remove:${victim.id}:10`,
      "admin:reset",
      `reset:continue:${reset.id}:${reset.token}`,
      `reset:delete:${reset.id}:${reset.token}`,
      `reset:cancel:${reset.id}`,
    ];

    for (const data of forgedCallbacks) await bot.handleUpdate(privateCallbackUpdate(attackerId, data));

    expect((await prisma.user.findUniqueOrThrow({ where: { id: victim.id } })).credits).toBe(80);
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: stock.id } })).status).toBe("AVAILABLE");
    expect((await prisma.category.findUniqueOrThrow({ where: { id: category.id } })).deletedAt).toBeNull();
    expect((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).deletedAt).toBeNull();
    expect((await prisma.resetChallenge.findUniqueOrThrow({ where: { id: reset.id } })).stage).toBe(1);
    expect(await prisma.creditTransaction.count()).toBe(0);
    expect(calls.filter((call) => call.method === "answerCallbackQuery")).toHaveLength(forgedCallbacks.length);
    expect(calls.some((call) => call.method.startsWith("editMessage"))).toBe(false);
  });

  it("backs up and scopes a reset before arming it, and lets the owner cancel", async () => {
    await makeUser(77_009n, 45);
    const beforeUsers = await prisma.user.count();
    const { bot, calls } = makeTestBot();
    await bot.handleUpdate(privateMessageUpdate(Number(OWNER_ID), "/reset"));

    const documentIndex = calls.findIndex(isDocumentCall);
    const previewIndex = calls.findIndex((call) => call.method === "sendRichMessage" &&
      richCallbackData(call.payload.rich_message).some((data) => data.startsWith("reset:continue:")));
    expect(documentIndex).toBeGreaterThanOrEqual(0);
    expect(previewIndex).toBeGreaterThan(documentIndex);
    expect(await prisma.user.count()).toBe(beforeUsers + 1);
    expect(await prisma.resetChallenge.count()).toBe(1);
    const challenge = await prisma.resetChallenge.findFirstOrThrow();
    expect(challenge.stage).toBe(1);

    const preview = calls[previewIndex];
    const cancelData = richCallbackData(preview?.payload.rich_message).find((data) => data.startsWith("reset:cancel:"));
    expect(cancelData).toBe(`reset:cancel:${challenge.id}`);
    await bot.handleUpdate(privateCallbackUpdate(Number(OWNER_ID), cancelData!));
    expect(await prisma.user.count()).toBe(beforeUsers + 1);
    expect((await prisma.resetChallenge.findUniqueOrThrow({ where: { id: challenge.id } })).usedAt).toBeInstanceOf(Date);
  });

  it("delivers the final fresh backup before the owner's last reset confirmation", async () => {
    await makeUser(77_010n, 45);
    const { product } = await makeProduct("Reset backup check", 10);
    await addInventoryItems(prisma, product.id, ["reset-private-stock"]);
    await prisma.adminAudit.create({ data: { ownerTelegramId: OWNER_ID, action: "BEFORE_FINAL_RESET" } });
    const { bot, calls } = makeTestBot();
    await bot.handleUpdate(privateMessageUpdate(Number(OWNER_ID), "/reset"));

    const initialPrompt = calls.find((call) => call.method === "sendRichMessage" &&
      richCallbackData(call.payload.rich_message).some((data) => data.startsWith("reset:continue:")));
    const continueData = richCallbackData(initialPrompt?.payload.rich_message)
      .find((data) => data.startsWith("reset:continue:"));
    expect(continueData).toBeDefined();
    const [, , challengeId] = continueData!.split(":");
    await bot.handleUpdate(privateCallbackUpdate(Number(OWNER_ID), continueData!));

    const finalPrompt = calls.filter((call) => call.method === "editMessageText").at(-1);
    const deleteData = richCallbackData(finalPrompt?.payload.rich_message).find((data) => data.startsWith("reset:delete:"));
    expect(deleteData).toBeDefined();
    const documentCallsBeforeDelete = calls.flatMap((call, index) => isDocumentCall(call) ? [index] : []);
    expect(documentCallsBeforeDelete).toHaveLength(2);
    expect(documentCallsBeforeDelete[1]).toBeLessThan(calls.indexOf(finalPrompt!));
    expect(await prisma.product.count()).toBe(1);
    expect(await prisma.inventoryItem.count()).toBe(1);

    const finalUpdate = privateCallbackUpdate(Number(OWNER_ID), deleteData!);
    const future = Date.now() + 2_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(future);
    try {
      await bot.handleUpdate(finalUpdate);
    } finally {
      clock.mockRestore();
    }

    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.product.count()).toBe(0);
    expect(await prisma.inventoryItem.count()).toBe(0);
    expect(await prisma.adminAudit.count()).toBe(2);
    expect(await prisma.adminAudit.count({ where: { action: "RESET_COMPLETED" } })).toBe(1);
    expect((await prisma.resetChallenge.findUniqueOrThrow({ where: { id: challengeId! } })).usedAt).toBeInstanceOf(Date);
    expect(calls.filter(isDocumentCall)).toHaveLength(2);
  });

  it("only accepts a purchase callback from the user with a live matching confirmation", async () => {
    const buyer = await makeUser(77_005n, 100);
    const impostorId = 77_006;
    const { product } = await makeProduct("Session-bound buy", 40);
    await addInventoryItems(prisma, product.id, ["private-delivery"]);
    const { bot, calls } = makeTestBot();

    const unconfirmed = `buy:confirm:${product.id}:${"a".repeat(16)}:${(40).toString(36)}`;
    await bot.handleUpdate(privateCallbackUpdate(impostorId, unconfirmed));
    expect(await prisma.purchase.count()).toBe(0);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: buyer.id } })).credits).toBe(100);

    await bot.handleUpdate(privateCallbackUpdate(Number(buyer.telegramId), `buy:start:${product.id}`));
    const confirmationCall = calls.filter((call) => call.method === "editMessageText").at(-1);
    const confirmData = richCallbackData(confirmationCall?.payload.rich_message)
      .find((data) => data.startsWith("buy:confirm:"));
    expect(confirmData).toMatch(/^buy:confirm:/);
    expect(confirmData).toBeDefined();

    await bot.handleUpdate(privateCallbackUpdate(impostorId, confirmData!));
    expect(await prisma.purchase.count()).toBe(0);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: buyer.id } })).credits).toBe(100);

    await bot.handleUpdate(privateCallbackUpdate(Number(buyer.telegramId), confirmData!));
    await bot.handleUpdate(privateCallbackUpdate(Number(buyer.telegramId), confirmData!));
    const purchase = await prisma.purchase.findFirstOrThrow();
    expect(purchase).toMatchObject({ buyerId: buyer.id, productId: product.id, amountPaid: 40 });
    expect(await prisma.purchase.count()).toBe(1);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: buyer.id } })).credits).toBe(60);
    expect(await prisma.creditTransaction.count({ where: { type: "PURCHASE" } })).toBe(1);
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: purchase.inventoryItemId } })).status).toBe("SOLD");
  });

  it("renders all bulk items and the same total when Telegram retries a purchase callback", async () => {
    const buyer = await makeUser(77_009n, 500);
    const { product } = await makeProduct("Bulk callback replay", 40);
    await addInventoryItems(prisma, product.id, ["callback-one", "callback-two", "callback-three"]);
    const { bot, calls } = makeTestBot();
    const telegramId = Number(buyer.telegramId);
    await bot.handleUpdate(privateCallbackUpdate(telegramId, `buy:qty:${product.id}:3`));
    const confirmation = calls.filter((call) => call.method === "editMessageText").at(-1);
    const confirmData = richCallbackData(confirmation?.payload.rich_message)
      .find((data) => data.startsWith("buy:confirm:"));
    expect(confirmData).toBeDefined();
    await bot.handleUpdate(privateCallbackUpdate(telegramId, confirmData!));
    const firstDelivery = calls.filter((call) => call.method === "editMessageText").at(-1)?.payload.rich_message;

    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2_000);
    try {
      await bot.handleUpdate(privateCallbackUpdate(telegramId, confirmData!));
    } finally {
      clock.mockRestore();
    }
    const replayDelivery = calls.filter((call) => call.method === "editMessageText").at(-1)?.payload.rich_message;
    expect(replayDelivery).toEqual(firstDelivery);
    for (const payload of ["callback-one", "callback-two", "callback-three"]) {
      expect(JSON.stringify(replayDelivery)).toContain(payload);
    }
    expect(JSON.stringify(replayDelivery)).toContain("120");
    expect(await prisma.purchase.count()).toBe(3);
    expect(await prisma.creditTransaction.count({ where: { type: "PURCHASE", amount: -120 } })).toBe(1);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: buyer.id } })).credits).toBe(380);
  });

  it("expires stale purchase-confirmation callbacks", async () => {
    const buyer = await makeUser(77_008n, 100);
    const { product } = await makeProduct("Expiring confirmation", 20);
    await addInventoryItems(prisma, product.id, ["expiry-private-stock"]);
    const { bot, calls } = makeTestBot();
    await bot.handleUpdate(privateCallbackUpdate(Number(buyer.telegramId), `buy:start:${product.id}`));
    const confirmationCall = calls.filter((call) => call.method === "editMessageText").at(-1);
    const confirmation = richCallbackData(confirmationCall?.payload.rich_message)
      .find((data) => data.startsWith("buy:confirm:"));
    expect(confirmation).toBeDefined();

    const expiredUpdate = privateCallbackUpdate(Number(buyer.telegramId), confirmation!);
    const future = Date.now() + 3 * 60 * 1_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(future);
    try {
      await bot.handleUpdate(expiredUpdate);
    } finally {
      clock.mockRestore();
    }

    expect(await prisma.purchase.count()).toBe(0);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: buyer.id } })).credits).toBe(100);
    expect(await countAvailableInventory(prisma, product.id)).toBe(1);
  });

  it("refuses a price change after display and recognizes only the specified owner ID", async () => {
    const buyer = await makeUser(77_007n, 100);
    const { product } = await makeProduct("Changing-price item", 30);
    await addInventoryItems(prisma, product.id, ["private-price-change"]);
    const { bot, calls } = makeTestBot();

    await bot.handleUpdate(privateCallbackUpdate(Number(buyer.telegramId), `buy:start:${product.id}`));
    const firstRichCall = calls.filter((call) => call.method === "editMessageText").at(-1);
    const staleData = richCallbackData(firstRichCall?.payload.rich_message)
      .find((data) => data.startsWith("buy:confirm:"));
    expect(staleData).toBeDefined();
    await prisma.product.update({ where: { id: product.id }, data: { price: 45 } });
    await bot.handleUpdate(privateCallbackUpdate(Number(buyer.telegramId), staleData!));

    expect(await prisma.purchase.count()).toBe(0);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: buyer.id } })).credits).toBe(100);
    expect(await countAvailableInventory(prisma, product.id)).toBe(1);

    await bot.handleUpdate(privateMessageUpdate(Number(OWNER_ID), "/admin"));
    expect(calls.some((call) => call.method === "sendRichMessage" && JSON.stringify(call.payload.rich_message).includes("ᴏᴡɴᴇʀ ᴄᴏɴꜱᴏʟᴇ"))).toBe(true);
    await bot.handleUpdate(privateCallbackUpdate(Number(OWNER_ID), "admin:panel"));
    expect(calls.some((call) => call.method === "editMessageText" && JSON.stringify(call.payload.rich_message ?? "").includes("ᴏᴡɴᴇʀ ᴄᴏɴꜱᴏʟᴇ"))).toBe(true);
  });

  it("returns safe responses for malformed owner and user commands", async () => {
    const { bot, calls } = makeTestBot();
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => {
      now += 2_000;
      return now;
    });
    try {
      const commands = ["/gift", "/gift abc 20", "/gift 123 abc", "/rm", "/code", "/redeem", "/redeem invalid-code"];
      for (const text of commands) await bot.handleUpdate(privateMessageUpdate(Number(OWNER_ID), text));
      const replies = calls
        .filter((call) => call.method === "sendMessage" || call.method === "sendRichMessage")
        .map((call) => JSON.stringify(call.payload.rich_message ?? call.payload.text));
      expect(replies).toHaveLength(commands.length);
      expect(replies.some((text) => text.includes("Use: /gift <userid> <credits>"))).toBe(true);
      expect(replies.some((text) => text.includes("positive Telegram user ID"))).toBe(true);
      expect(replies.some((text) => text.includes("positive whole number"))).toBe(true);
      expect(replies.some((text) => text.includes("Use: /rm <userid> <credits>"))).toBe(true);
      expect(replies.some((text) => text.includes("Use: /code <amount> <credits> <maxredeems>"))).toBe(true);
      expect(replies.some((text) => text.includes("/redeem IRIS-XXXX"))).toBe(true);
      expect(replies.some((text) => text.includes("invalid, expired, or fully redeemed"))).toBe(true);
      expect(replies.every((text) => !text.includes(" at ") && !text.includes("Error:"))).toBe(true);
    } finally {
      clock.mockRestore();
    }
  });

  it("does not treat /skip as data for required admin-flow fields", async () => {
    const { bot } = makeTestBot();
    await bot.handleUpdate(privateCallbackUpdate(Number(OWNER_ID), "admin:category:add"));
    await bot.handleUpdate(privateMessageUpdate(Number(OWNER_ID), "/skip"));
    expect(await prisma.category.count()).toBe(0);
  });
});

describe("customer wallet activity", () => {
  it("shows a private, escaped, paginated wallet history from /wallet and its callback", async () => {
    const user = await makeUser(95_001n, 250);
    const otherUser = await makeUser(95_002n, 900);
    const baseTime = Date.now();
    await prisma.creditTransaction.createMany({
      data: Array.from({ length: 9 }, (_, index) => ({
        id: `wallet-view-${index}`,
        userId: user.id,
        amount: index % 2 === 0 ? 10 : -5,
        type: index % 2 === 0 ? "BONUS" as const : "PURCHASE" as const,
        description: index === 8 ? "<script>private</script>&" : `Ledger event ${index}`,
        balanceAfter: 100 + index,
        createdAt: new Date(baseTime + index * 1_000),
      })),
    });
    await prisma.creditTransaction.create({
      data: {
        id: "wallet-view-other",
        userId: otherUser.id,
        amount: 50,
        type: "GIFT",
        description: "Other user's private activity",
        balanceAfter: 950,
      },
    });

    const { bot, calls } = makeTestBot();
    await bot.handleUpdate(privateMessageUpdate(Number(user.telegramId), "/wallet"));
    const firstPage = calls.filter((call) => call.method === "sendRichMessage").at(-1);
    const firstRich = JSON.stringify(firstPage?.payload.rich_message);
    expect(firstRich).toContain("250 ᴄʀᴇᴅɪᴛꜱ");
    // Rich text cells carry literal user text rather than HTML, so markup-looking values stay inert plain text.
    expect(firstRich).toContain("<script>private</script>&");
    expect(firstRich).not.toContain("Other user's private activity");
    expect(firstRich).toContain("Ledger event 7");
    expect(firstRich).not.toContain("Ledger event 0");

    const nextPageData = richCallbackData(firstPage?.payload.rich_message).find((data) => data === "wallet:page:1");
    expect(nextPageData).toBe("wallet:page:1");
    await bot.handleUpdate(privateCallbackUpdate(Number(user.telegramId), nextPageData!));

    const secondPage = calls.filter((call) => call.method === "editMessageText").at(-1);
    const secondRich = JSON.stringify(secondPage?.payload.rich_message);
    expect(secondRich).toContain("Ledger event 0");
    expect(secondRich).not.toContain("Ledger event 7");
    expect(secondRich).not.toContain("Other user's private activity");
  });
});

describe("Telegram message editing", () => {
  const logger = {
    trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(),
  } as unknown as AppLogger;

  it("renders legacy menu copy and inline callbacks through rich HTML button rows", async () => {
    const api = { editMessageText: vi.fn().mockResolvedValue(true) };
    const reply = vi.fn().mockResolvedValue(undefined);
    const context = {
      callbackQuery: {
        message: {
          message_id: 99,
          date: 1,
          chat: { id: 88_000, type: "private" },
          text: "Old menu",
        },
      },
      api,
      reply,
    } as unknown as BotContext;

    await editOrReply(context, "<b>Store menu</b>", new InlineKeyboard().text("Back to store", "nav:store"), logger);

    const richInput = api.editMessageText.mock.calls[0]?.[2] as { html?: string } | undefined;
    expect(richInput?.html).toContain("<b>Store menu</b>");
    expect(richInput?.html).toContain('<tg-button type="callback_data" data="nav:store">ʙᴀᴄᴋ ᴛᴏ ꜱᴛᴏʀᴇ</tg-button>');
  });

  it("ignores unchanged-edit errors and falls back when a callback message cannot be edited", async () => {
    const makeContext = (error: GrammyError) => {
      const api = { editMessageText: vi.fn().mockRejectedValue(error) };
      const reply = vi.fn().mockResolvedValue(undefined);
      const context = {
        callbackQuery: {
          message: {
            message_id: 1,
            date: 1,
            chat: { id: 88_001, type: "private" },
            text: "Current menu",
          },
        },
        api,
        reply,
      } as unknown as BotContext;
      return { context, api, reply };
    };
    const unchanged = new GrammyError(
      "Call to 'editMessageText' failed!",
      { ok: false, error_code: 400, description: "Bad Request: message is not modified" },
      "editMessageText",
      {},
    );
    const unchangedContext = makeContext(unchanged);
    await editOrReply(unchangedContext.context, "Current menu", undefined, logger);
    expect(unchangedContext.reply).not.toHaveBeenCalled();

    const expired = new GrammyError(
      "Call to 'editMessageText' failed!",
      { ok: false, error_code: 400, description: "Bad Request: message to edit not found" },
      "editMessageText",
      {},
    );
    const expiredContext = makeContext(expired);
    await expect(editOrReply(expiredContext.context, "Fresh menu", undefined, logger)).resolves.toBeUndefined();
    expect(expiredContext.reply).toHaveBeenCalledTimes(1);
  });

  it("falls back to HTML and the legacy keyboard if a rich-message edit is rejected", async () => {
    const unsupported = new GrammyError(
      "Call to 'editMessageText' failed!",
      { ok: false, error_code: 400, description: "Bad Request: rich message blocks are not supported" },
      "editMessageText",
      {},
    );
    const api = { editMessageText: vi.fn().mockRejectedValue(unsupported) };
    const reply = vi.fn().mockResolvedValue(undefined);
    const context = {
      callbackQuery: {
        message: {
          message_id: 2,
          date: 1,
          chat: { id: 88_002, type: "private" },
          text: "Old menu",
        },
      },
      api,
      reply,
    } as unknown as BotContext;
    const fallbackKeyboard = new InlineKeyboard().text("Back to store", "nav:store");

    await editOrReplyRich(
      context,
      { blocks: [{ type: "heading", size: 2, text: "Rich screen" }] },
      "Plain-text fallback",
      { fallbackKeyboard, logger },
    );

    expect(api.editMessageText).toHaveBeenCalledTimes(2);
    expect(reply).toHaveBeenCalledWith(
      "Plain-text fallback",
      expect.objectContaining({ reply_markup: fallbackKeyboard, parse_mode: "HTML" }),
    );
  });
});

describe("smart account delivery, presets, order vault, warranty, and restock alerts", () => {
  it("parses email:pass, pipe-separated Crunchyroll details, colon-extended lines, and keys", () => {
    const simple = parseDeliveryPayload("animefan@mail.com:Secret123!");
    expect(simple).toMatchObject({
      kind: "account",
      login: "animefan@mail.com",
      password: "Secret123!",
      extraFields: [],
    });

    const rich = parseDeliveryPayload(
      "otaku@mail.com:Pass999 | Plan: Mega Fan | Expiry: 2027-01-15 | Region: US | Profile: #2 | PIN: 4321",
    );
    expect(rich.kind).toBe("account");
    expect(rich.login).toBe("otaku@mail.com");
    expect(rich.password).toBe("Pass999");
    expect(rich.extraFields).toEqual([
      { icon: "💎", label: "Plan / Tier", value: "Mega Fan", copyable: false },
      { icon: "⏳", label: "Validity / Expiry", value: "2027-01-15", copyable: false },
      { icon: "🌍", label: "Region", value: "US", copyable: false },
      { icon: "👤", label: "Profile / Screen", value: "#2", copyable: false },
      { icon: "🔢", label: "PIN", value: "4321", copyable: true },
    ]);

    const colonRich = parseDeliveryPayload("user@cr.com:Pass123:Mega Fan:30 Days");
    expect(colonRich.kind).toBe("account");
    expect(colonRich.extraFields).toHaveLength(2);
    expect(colonRich.extraFields[0]?.value).toBe("Mega Fan");
    expect(colonRich.extraFields[1]?.value).toBe("30 Days");

    const key = parseDeliveryPayload("CRUNCHY-XXXX-YYYY-ZZZZ");
    expect(key.kind).toBe("key");
  });

  it("delivers Crunchyroll preset details, login rules, and generates a .txt receipt", async () => {
    const buyer = await makeUser(91_001n, 200);
    const { product } = await makeProduct("Crunchyroll Mega Fan", 60);
    await applyProductPreset(prisma, product.id, "crunchyroll");
    await addInventoryItems(prisma, product.id, [
      "crunchy@anime.jp:UltraSecret | Plan: Mega Fan | Expiry: 2027-03-01 | Profile: #3 | PIN: 9988",
    ]);

    const purchase = await purchaseProduct(prisma, buyer.id, product.id, "purchase:crunchyroll-1");
    expect(purchase.planDetails).toContain("Mega Fan");
    expect(purchase.deliveryInstructions).toContain("crunchyroll.com");
    expect(purchase.warrantyHours).toBe(24);

    const html = purchaseDeliveryMessage(purchase);
    expect(html).toContain("crunchy@anime.jp");
    expect(html).toContain("UltraSecret");
    expect(html).toContain("Mega Fan");
    expect(html).toContain("2027-03-01");
    expect(html).toContain("9988");
    expect(html).toContain("crunchyroll.com");

    const txt = buildOrderReceiptText({
      purchaseId: purchase.purchaseId,
      productName: purchase.productName,
      paid: purchase.paid,
      createdAt: new Date("2026-09-30T00:00:00Z"),
      payload: purchase.payload,
      planDetails: purchase.planDetails ?? "",
      deliveryInstructions: purchase.deliveryInstructions ?? "",
      warrantyHours: purchase.warrantyHours ?? 0,
    });
    expect(txt).toContain("Login / Email : crunchy@anime.jp");
    expect(txt).toContain("Password      : UltraSecret");
    expect(txt).toContain("Plan / Tier   : Mega Fan");
    expect(txt).toContain("ACCOUNT / PLAN DETAILS");
    expect(txt).toContain("IMPORTANT RULES & LOGIN INSTRUCTIONS");
  });

  it("uses Bot API 10.3 rich tables, styled buttons, and expandable delivery details", async () => {
    const buyer = await makeUser(91_010n, 250);
    const { product } = await makeProduct("Rich-table streaming", 40);
    await addInventoryItems(prisma, product.id, ["buyer@example.test:StrongPass123 | Plan: Premium"]);
    const { bot, calls } = makeTestBot();
    const telegramId = Number(buyer.telegramId);

    await bot.handleUpdate(privateCallbackUpdate(telegramId, `store:product:${product.id}`));
    let richCall = calls.filter((call) => call.method === "editMessageText").at(-1);
    const productRichMessage = JSON.stringify(richCall?.payload.rich_message);
    expect(productRichMessage).toContain("table");
    expect(productRichMessage).toContain("is_bordered");
    expect(productRichMessage).toContain("is_striped");
    expect(productRichMessage).toContain("ɴᴏ ʀᴇꜰᴜɴᴅꜱ");
    expect(richCallbackData(richCall?.payload.rich_message)).toContain(`buy:start:${product.id}`);

    await bot.handleUpdate(privateCallbackUpdate(telegramId, `buy:start:${product.id}`));
    richCall = calls.filter((call) => call.method === "editMessageText").at(-1);
    expect(JSON.stringify(richCall?.payload.rich_message)).toContain("ʀᴇᴠɪᴇᴡ ʙᴇꜰᴏʀᴇ ʙᴜʏɪɴɢ");
    const confirmData = richCallbackData(richCall?.payload.rich_message)
      .find((data) => data.startsWith("buy:confirm:"));
    expect(confirmData).toBeDefined();

    await bot.handleUpdate(privateCallbackUpdate(telegramId, confirmData!));
    richCall = calls.filter((call) => call.method === "editMessageText").at(-1);
    const delivery = JSON.stringify(richCall?.payload.rich_message);
    expect(delivery).toContain("buyer@example.test");
    expect(delivery).toContain("StrongPass123");
    expect(delivery).toContain("table");
    expect(delivery).toContain("expandable_blockquote");
    expect(richCallbackData(richCall?.payload.rich_message)).toContain("nav:orders");
    expect(await prisma.purchase.count({ where: { buyerId: buyer.id } })).toBe(1);

    await bot.handleUpdate(privateCallbackUpdate(telegramId, "nav:orders"));
    richCall = calls.filter((call) => call.method === "editMessageText").at(-1);
    const ordersRichMessage = JSON.stringify(richCall?.payload.rich_message);
    expect(ordersRichMessage).toContain("ᴏʀᴅᴇʀ ʜɪꜱᴛᴏʀʏ");
    expect(ordersRichMessage).toContain("Rich-table streaming");
    const orderId = await prisma.purchase.findFirstOrThrow({ where: { buyerId: buyer.id } }).then((order) => order.id);
    expect(richCallbackData(richCall?.payload.rich_message)).toContain(`order:view:${orderId}`);

    await bot.handleUpdate(privateCallbackUpdate(telegramId, `order:view:${orderId}`));
    richCall = calls.filter((call) => call.method === "editMessageText").at(-1);
    const orderDetail = JSON.stringify(richCall?.payload.rich_message);
    expect(orderDetail).toContain("ʟᴏɢɪɴ ᴅᴇᴛᴀɪʟꜱ");
    expect(orderDetail).toContain("buyer@example.test");
    expect(orderDetail).toContain("StrongPass123");
    expect(orderDetail).toContain("expandable_blockquote");
    expect(richCallbackData(richCall?.payload.rich_message)).toContain(`order:txt:${orderId}`);

    await bot.handleUpdate(privateCallbackUpdate(telegramId, `order:txt:${orderId}`));
    const receiptCall = calls.filter((call) => call.method === "sendRichMessage").at(-1);
    const receiptBlocks = (receiptCall?.payload.rich_message as { blocks?: Array<Record<string, unknown>> } | undefined)?.blocks;
    const receiptBlock = receiptBlocks?.find((block) => block.type === "document");
    expect(receiptBlock).toBeDefined();
    expect(receiptBlock?.caption).toMatchObject({ text: `📄 ᴏʀᴅᴇʀ ʀᴇᴄᴇɪᴘᴛ · #${orderId.slice(0, 8)}` });

    const lowFundsUser = await makeUser(91_011n, 5);
    const { product: unaffordableProduct } = await makeProduct("Premium add-on", 20);
    await addInventoryItems(prisma, unaffordableProduct.id, ["available@item.test:pass"]);
    await bot.handleUpdate(privateCallbackUpdate(Number(lowFundsUser.telegramId), `buy:start:${unaffordableProduct.id}`));
    richCall = calls.filter((call) => call.method === "editMessageText").at(-1);
    expect(JSON.stringify(richCall?.payload.rich_message)).toContain("Short by 15");
    const unaffordableButtons = richCallbackData(richCall?.payload.rich_message);
    expect(unaffordableButtons).toContain("nav:bonus");
    expect(unaffordableButtons.some((data) => data.startsWith("buy:confirm:"))).toBe(false);
    expect(await prisma.purchase.count({ where: { buyerId: lowFundsUser.id } })).toBe(0);
  });

  it("supports cloning products, searching catalog, featured items, peeking stock, and bulk clearing", async () => {
    const { product } = await makeProduct("Crunchyroll 1 Month", 45);
    await applyProductPreset(prisma, product.id, "crunchyroll");
    await updateProduct(prisma, product.id, { featured: true });
    await addInventoryItems(prisma, product.id, ["acc1@cr.com:pass1", "acc2@cr.com:pass2"]);

    const featured = await listFeaturedProducts(prisma);
    expect(featured.total).toBe(1);
    expect(featured.products[0]?.id).toBe(product.id);

    const search = await searchProducts(prisma, "crunchyroll");
    expect(search.total).toBe(1);
    expect(search.products[0]?.name).toBe("Crunchyroll 1 Month");

    const cloned = await cloneProduct(prisma, product.id);
    expect(cloned.name).toBe("Crunchyroll 1 Month (Copy)");
    expect(cloned.planDetails).toBe((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).planDetails);
    expect(cloned.enabled).toBe(false);

    const list = await listAvailableInventory(prisma, product.id);
    const peeked = await getAvailableInventoryItem(prisma, list[0]!.id);
    expect(peeked.payload).toBe("acc1@cr.com:pass1");

    const exported = await listAllAvailablePayloads(prisma, product.id);
    expect(exported.payloads).toEqual(["acc1@cr.com:pass1", "acc2@cr.com:pass2"]);

    const cleared = await clearAvailableInventory(prisma, product.id);
    expect(cleared.removed).toBe(2);
    expect(await countAvailableInventory(prisma, product.id)).toBe(0);
  });

  it("keeps Order Vault history and resolves delivery claims with replacement only (no refunds)", async () => {
    const buyer = await makeUser(92_001n, 300);
    const { product } = await makeProduct("Netflix UHD", 80);
    await applyProductPreset(prisma, product.id, "streaming");
    await addInventoryItems(prisma, product.id, [
      "dead@nf.com:badpass | Profile: #1",
    ]);

    const firstOrder = await purchaseProduct(prisma, buyer.id, product.id, "purchase:nf-1");
    expect(firstOrder.payload).toContain("dead@nf.com");

    const detailBefore = await getUserPurchaseDetail(prisma, buyer.id, firstOrder.purchaseId);
    expect(detailBefore.inventoryItem.payload).toContain("dead@nf.com");

    await addInventoryItems(prisma, product.id, [
      "fresh@nf.com:goodpass | Profile: #2",
    ]);
    const claim = await submitWarrantyClaim(prisma, buyer.id, firstOrder.purchaseId, "Invalid password on login");
    expect(claim.status).toBe("PENDING");
    expect((await listWarrantyClaims(prisma)).pendingCount).toBe(1);

    const replaced = await resolveWarrantyClaimReplace(prisma, claim.id);
    expect(replaced.replacementPayload).toContain("fresh@nf.com");

    const detailAfter = await getUserPurchaseDetail(prisma, buyer.id, firstOrder.purchaseId);
    expect(detailAfter.inventoryItem.payload).toContain("fresh@nf.com");
    expect(detailAfter.warrantyClaim?.status).toBe("REPLACED");

    // A pending issue can be replaced or rejected; there is no refund option or handler.
    await addInventoryItems(prisma, product.id, ["another@nf.com:pass3"]);
    const secondOrder = await purchaseProduct(prisma, buyer.id, product.id, "purchase:nf-2");
    const secondClaim = await submitWarrantyClaim(prisma, buyer.id, secondOrder.purchaseId, "Account locked");
    const beforeAttempt = await prisma.user.findUniqueOrThrow({ where: { id: buyer.id } });
    const { bot, calls } = makeTestBot();
    await bot.handleUpdate(privateCallbackUpdate(Number(OWNER_ID), `admin:warranty:view:${secondClaim.id}`));
    const claimDetail = calls.filter((call) => call.method === "editMessageText").at(-1);
    const claimButtons = richCallbackData(claimDetail?.payload.rich_message);
    expect(claimButtons).toContain(`admin:warranty:replace:${secondClaim.id}`);
    expect(claimButtons).toContain(`admin:warranty:reject:${secondClaim.id}`);
    expect(claimButtons?.some((data) => data?.includes("refund"))).toBe(false);

    await bot.handleUpdate(privateCallbackUpdate(Number(OWNER_ID), `admin:warranty:refund:${secondClaim.id}`));
    const noRefundResponse = calls.filter((call) => call.method === "editMessageText").at(-1);
    expect(JSON.stringify(noRefundResponse?.payload.rich_message)).toContain("ʀᴇꜰᴜɴᴅꜱ ᴀʀᴇ ɴᴏᴛ ᴏꜰꜰᴇʀᴇᴅ");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: buyer.id } })).credits).toBe(beforeAttempt.credits);
    expect((await prisma.warrantyClaim.findUniqueOrThrow({ where: { id: secondClaim.id } })).status).toBe("PENDING");
    expect(await prisma.creditTransaction.count({ where: { userId: buyer.id, type: "REFUND" } })).toBe(0);
  });

  it("lets buyers subscribe to restock alerts and auto-notifies them when the owner adds stock", async () => {
    const subscriber = await makeUser(93_001n, 100);
    const { product } = await makeProduct("Spotify Premium", 30);

    expect(await isSubscribedToStock(prisma, subscriber.id, product.id)).toBe(false);
    const subResult = await toggleStockSubscription(prisma, subscriber.id, product.id);
    expect(subResult.subscribed).toBe(true);
    expect(await isSubscribedToStock(prisma, subscriber.id, product.id)).toBe(true);

    const { bot, calls } = makeTestBot();
    await bot.handleUpdate(privateCallbackUpdate(Number(OWNER_ID), `admin:stock:add:${product.id}`));
    await bot.handleUpdate(privateMessageUpdate(Number(OWNER_ID), "spot@music.com:pass123 | Plan: Individual"));

    const restockAlert = calls.find(
      (call) => call.method === "sendRichMessage" && Number(call.payload.chat_id) === Number(subscriber.telegramId),
    );
    expect(restockAlert).toBeDefined();
    expect(JSON.stringify(restockAlert?.payload.rich_message)).toContain("Spotify Premium");
    expect(await isSubscribedToStock(prisma, subscriber.id, product.id)).toBe(false);
    expect(await consumeStockSubscribers(prisma, product.id)).toHaveLength(0);
  });

  it("supports multi-quantity bulk purchases and unlimited reusable digital products", async () => {
    const buyer = await makeUser(94_001n, 500);
    const { product: bulkProduct } = await makeProduct("Crunchyroll Bulk", 40);
    await addInventoryItems(prisma, bulkProduct.id, [
      "cr1@mail.com:pass1",
      "cr2@mail.com:pass2",
      "cr3@mail.com:pass3",
    ]);

    const bulkOrder = await purchaseProduct(prisma, buyer.id, bulkProduct.id, "purchase:bulk-3", 40, 3);
    expect(bulkOrder.quantity).toBe(3);
    expect(bulkOrder.paid).toBe(120);
    expect(bulkOrder.remainingCredits).toBe(380);
    expect(new Set(bulkOrder.payloads)).toEqual(new Set(["cr1@mail.com:pass1", "cr2@mail.com:pass2", "cr3@mail.com:pass3"]));
    expect(await countAvailableInventory(prisma, bulkProduct.id)).toBe(0);

    const { product: unlimitedProduct } = await makeProduct("Private Guide / Link", 25);
    await updateProduct(prisma, unlimitedProduct.id, { isUnlimited: true });
    await addInventoryItems(prisma, unlimitedProduct.id, ["https://example.com/private-guide"]);

    const firstUnlimited = await purchaseProduct(prisma, buyer.id, unlimitedProduct.id, "purchase:unlim-1", 25, 1);
    const secondUnlimited = await purchaseProduct(prisma, buyer.id, unlimitedProduct.id, "purchase:unlim-2", 25, 1);
    expect(firstUnlimited.payload).toBe("https://example.com/private-guide");
    expect(secondUnlimited.payload).toBe("https://example.com/private-guide");
    const unlimitedBulk = await purchaseProduct(prisma, buyer.id, unlimitedProduct.id, "purchase:unlim-bulk", 25, 3);
    expect(await purchaseProduct(prisma, buyer.id, unlimitedProduct.id, "purchase:unlim-bulk"))
      .toEqual({ ...unlimitedBulk, repeated: true });
    expect(unlimitedBulk).toMatchObject({ quantity: 3, paid: 75 });
    expect(unlimitedBulk.payloads).toEqual(Array(3).fill("https://example.com/private-guide"));
    expect(await prisma.inventoryItem.count({ where: { productId: unlimitedProduct.id, status: "SOLD" } })).toBe(5);
    expect(await countAvailableInventory(prisma, unlimitedProduct.id)).toBe(1);
  });
});

describe("refer & earn, my referrals, and owner referral controls", () => {
  it("builds and parses referral deep-link payloads safely", () => {
    expect(buildReferralLink("iris_test_bot", 98_001n)).toBe("https://t.me/iris_test_bot?start=ref_98001");
    expect(parseReferralStartPayload("ref_98001")).toBe(98_001n);
    expect(parseReferralStartPayload("R_98001")).toBe(98_001n);
    expect(parseReferralStartPayload("")).toBeNull();
    expect(parseReferralStartPayload("ref_0")).toBeNull();
    expect(parseReferralStartPayload("ref_abc")).toBeNull();
  });

  it("rewards both referrer and new friend on first /start and blocks self or repeat referrals", async () => {
    const referrer = await makeUser(98_100n, 20);
    await prisma.user.update({
      where: { id: referrer.id },
      data: { username: "inviter_pro", firstName: "Inviter" },
    });

    const { bot, calls } = makeTestBot();
    const newFriendTelegramId = 98_101;
    await bot.handleUpdate(privateMessageUpdate(newFriendTelegramId, `/start ref_${referrer.telegramId.toString()}`));

    const updatedReferrer = await prisma.user.findUniqueOrThrow({ where: { id: referrer.id } });
    const newFriend = await prisma.user.findUniqueOrThrow({ where: { telegramId: BigInt(newFriendTelegramId) } });

    expect(updatedReferrer.credits).toBe(30); // 20 + 10 default referrer reward
    expect(newFriend.credits).toBe(5); // +5 default welcome bonus
    expect(newFriend.referredById).toBe(referrer.id);
    expect(newFriend.referralRewardCredits).toBe(10);
    expect(newFriend.referralWelcomeCredits).toBe(5);

    const referralTx = await prisma.creditTransaction.findMany({
      where: { type: "REFERRAL" },
      orderBy: { amount: "asc" },
    });
    expect(referralTx).toHaveLength(2);
    expect(referralTx[0]).toMatchObject({ userId: newFriend.id, amount: 5, balanceAfter: 5 });
    expect(referralTx[1]).toMatchObject({ userId: referrer.id, amount: 10, balanceAfter: 30 });

    // Referrer receives a direct Telegram notification
    const referrerNotice = calls.find(
      (call) =>
        (call.method === "sendRichMessage" || call.method === "sendMessage") &&
        Number(call.payload.chat_id) === Number(referrer.telegramId),
    );
    expect(referrerNotice).toBeDefined();
    expect(JSON.stringify(referrerNotice?.payload)).toContain("10 ᴄʀᴇᴅɪᴛꜱ");

    // Existing user cannot claim referral again
    await bot.handleUpdate(privateMessageUpdate(newFriendTelegramId, `/start ref_${referrer.telegramId.toString()}`));
    expect((await prisma.user.findUniqueOrThrow({ where: { id: referrer.id } })).credits).toBe(30);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: newFriend.id } })).credits).toBe(5);

    // Self-referral by a brand-new user is rejected
    const selfUserTelegramId = 98_102;
    const selfResult = await processReferralStart(
      prisma,
      { id: selfUserTelegramId, is_bot: false, first_name: "Self" },
      `ref_${selfUserTelegramId}`,
    );
    expect(selfResult.referralApplied).toBe(false);
    expect(selfResult.referralIgnoreReason).toBe("self_referral");
    expect(selfResult.user.credits).toBe(0);
  });

  it("displays Refer & Earn and paginated My Referrals views and supports owner settings", async () => {
    const referrer = await makeUser(98_200n, 50);
    await updateReferralSettings(prisma, { referrerCredits: 15, inviteeCredits: 8 });
    expect(await getReferralSettings(prisma)).toEqual({
      enabled: true,
      referrerCredits: 15,
      inviteeCredits: 8,
    });

    for (let i = 1; i <= 9; i++) {
      await processReferralStart(
        prisma,
        {
          id: 98_200 + i,
          is_bot: false,
          first_name: `Friend ${i}`,
          username: `friend_${i}`,
        },
        `ref_${referrer.telegramId.toString()}`,
      );
    }

    const summary = await getUserReferralSummary(prisma, referrer.id);
    expect(summary.totalReferrals).toBe(9);
    expect(summary.totalEarned).toBe(135); // 9 * 15

    const firstPage = await listUserReferrals(prisma, referrer.id, 0, 8);
    expect(firstPage.total).toBe(9);
    expect(firstPage.pages).toBe(2);
    expect(firstPage.referrals).toHaveLength(8);

    const { bot, calls } = makeTestBot();
    await bot.handleUpdate(privateMessageUpdate(Number(referrer.telegramId), "/refer"));
    const referScreen = calls.filter((call) => call.method === "sendRichMessage").at(-1);
    const referRich = JSON.stringify(referScreen?.payload.rich_message);
    expect(referRich).toContain("https://t.me/iris_test_bot?start=ref_98200");
    expect(referRich).toContain("135 ᴄʀᴇᴅɪᴛꜱ");
    expect(richCallbackData(referScreen?.payload.rich_message)).toContain("refer:list:0");

    await bot.handleUpdate(privateCallbackUpdate(Number(referrer.telegramId), "refer:list:0"));
    const listPage0 = calls.filter((call) => call.method === "editMessageText").at(-1);
    const listPage0Rich = JSON.stringify(listPage0?.payload.rich_message);
    expect(listPage0Rich).toContain("@friend_9");
    expect(richCallbackData(listPage0?.payload.rich_message)).toContain("refer:list:1");

    await bot.handleUpdate(privateCallbackUpdate(Number(referrer.telegramId), "refer:list:1"));
    const listPage1 = calls.filter((call) => call.method === "editMessageText").at(-1);
    expect(JSON.stringify(listPage1?.payload.rich_message)).toContain("@friend_1");

    // Owner can toggle and update referral settings from the admin panel
    await bot.handleUpdate(privateCallbackUpdate(Number(OWNER_ID), "admin:settings:referral:toggle"));
    expect((await getReferralSettings(prisma)).enabled).toBe(false);

    const whileDisabled = await processReferralStart(
      prisma,
      { id: 98_299, is_bot: false, first_name: "Latecomer" },
      `ref_${referrer.telegramId.toString()}`,
    );
    expect(whileDisabled.referralApplied).toBe(false);
    expect(whileDisabled.referralIgnoreReason).toBe("disabled");

    await toggleReferralEnabled(prisma);
    await bot.handleUpdate(privateCallbackUpdate(Number(OWNER_ID), "admin:settings:referral"));
    await bot.handleUpdate(privateMessageUpdate(Number(OWNER_ID), "25 10"));
    expect(await getReferralSettings(prisma)).toEqual({
      enabled: true,
      referrerCredits: 25,
      inviteeCredits: 10,
    });
  });
});


