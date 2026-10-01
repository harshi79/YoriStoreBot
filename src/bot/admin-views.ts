import { InlineKeyboard } from "grammy";
import type { BotContext } from "../types/context.js";
import type { BotDependencies } from "./dependencies.js";
import {
  adminBackKeyboard,
  adminPanelKeyboard,
  categoryDetailKeyboard,
  categoryListAdminKeyboard,
  categoryProductsAdminKeyboard,
  codeListKeyboard,
  inventoryCategoriesKeyboard,
  inventoryProductsKeyboard,
  productDetailKeyboard,
  productListKeyboard,
  productPresetsKeyboard,
  userPaginationKeyboard,
} from "../keyboards/inline.js";
import { editOrReply, editOrReplyRich } from "./render.js";
import { adminPanelMessage } from "../messages/admin.js";
import {
  getAvailableInventoryItem,
  getProduct,
  listAdminProducts,
  listAvailableInventory,
  listCategories,
  listCategoryProducts,
} from "../services/store.service.js";
import { getWarrantyClaimDetail, listWarrantyClaims } from "../services/purchases.service.js";
import { listRedeemCodes } from "../services/codes.service.js";
import { listUsersPage, getStoreStatistics } from "../services/analytics.service.js";
import { renderParsedPayloadBlock } from "../messages/iris.js";
import { creditLabel, escapeHtml, formatDate, smallCaps } from "../utils/format.js";

const PAGE_SIZE = 8;

export async function showAdminPanel(ctx: BotContext, deps: BotDependencies): Promise<void> {
  const fallback = `👑 <b>Iris · Owner console</b>\n\n` +
    `Manage your catalog, stock, customers, orders, and operations from one place. ` +
    `Reset always sends a backup and asks for two confirmations.`;
  await editOrReplyRich(ctx, adminPanelMessage(), fallback, {
    fallbackKeyboard: adminPanelKeyboard(),
    logger: deps.logger,
  });
}

export async function showCategoriesAdmin(ctx: BotContext, deps: BotDependencies): Promise<void> {
  const categories = await listCategories(deps.database.prisma);
  const active = categories.filter((category) => category.enabled).length;
  await editOrReply(
    ctx,
    `🗂 <b>${smallCaps("Categories")}</b>\n\n${categories.length} total · ${active} enabled\n${smallCaps("Categories are created and managed here; the customer store has no hard-coded sections.")}`,
    categoryListAdminKeyboard(categories),
    deps.logger,
  );
}

export async function showCategoryAdmin(
  ctx: BotContext,
  deps: BotDependencies,
  categoryId: string,
): Promise<void> {
  const category = await deps.database.prisma.category.findFirst({
    where: { id: categoryId, deletedAt: null },
    include: { _count: { select: { products: { where: { deletedAt: null } } } } },
  });
  if (!category) {
    await editOrReply(ctx, "That category no longer exists.", adminBackKeyboard(), deps.logger);
    return;
  }
  const text = `${escapeHtml(category.emoji)} <b>${escapeHtml(category.name)}</b>\n\n` +
    `<b>Description:</b> ${escapeHtml(category.description || "No description")}\n` +
    `<b>Status:</b> ${category.enabled ? "Enabled" : "Disabled"}\n` +
    `<b>Order:</b> ${category.displayOrder + 1}\n` +
    `<b>Products:</b> ${category._count.products}`;
  await editOrReply(ctx, text, categoryDetailKeyboard(category), deps.logger);
}

export async function showProductsAdmin(ctx: BotContext, deps: BotDependencies, page: number): Promise<void> {
  const result = await listAdminProducts(deps.database.prisma, page, PAGE_SIZE);
  await editOrReply(
    ctx,
    `📦 <b>${smallCaps("Products")}</b>\n\n${result.total} product(s) · tap one to edit details, presets, or stock.`,
    productListKeyboard(result.products, page, result.pages, "admin:panel", "admin"),
    deps.logger,
  );
}

export async function showCategoryProductsAdmin(
  ctx: BotContext,
  deps: BotDependencies,
  categoryId: string,
  page: number,
): Promise<void> {
  const category = await deps.database.prisma.category.findFirst({ where: { id: categoryId, deletedAt: null } });
  if (!category) {
    await editOrReply(ctx, "That category no longer exists.", adminBackKeyboard(), deps.logger);
    return;
  }
  const result = await listCategoryProducts(deps.database.prisma, categoryId, page, PAGE_SIZE, true);
  await editOrReply(
    ctx,
    `${escapeHtml(category.emoji)} <b>${escapeHtml(category.name)} · products</b>\n\n${result.total} product(s).`,
    categoryProductsAdminKeyboard(result.products, categoryId, page, result.pages),
    deps.logger,
  );
}

export async function showProductAdmin(ctx: BotContext, deps: BotDependencies, productId: string): Promise<void> {
  const product = await getProduct(deps.database.prisma, productId);
  const text = `${escapeHtml(product.emoji)} <b>${escapeHtml(product.name)}</b>${product.featured ? " 🔥" : ""}\n\n` +
    `<b>Category:</b> ${escapeHtml(product.category.name)}\n` +
    `<b>Price:</b> ${creditLabel(product.price)}\n` +
    `<b>Delivery mode:</b> ${product.isUnlimited ? "♾ Unlimited / Reusable" : "1️⃣ One-Time Stock"}\n` +
    `<b>Available stock:</b> ${product.isUnlimited && product._count.inventory > 0 ? `♾ Unlimited (${product._count.inventory} template)` : product._count.inventory}\n` +
    `<b>Restock subscribers:</b> ${product._count.stockSubscriptions}\n` +
    `<b>Warranty:</b> ${product.warrantyHours > 0 ? `${product.warrantyHours}h replacement` : "None (0h)"}\n` +
    `<b>Banner photo:</b> ${product.mediaFileId ? "Attached 🖼" : "None"}\n` +
    `<b>Status:</b> ${product.enabled ? "Enabled" : "Disabled"}${product.featured ? " · Featured 🔥" : ""}\n\n` +
    `💎 <b>Plan / Account specs:</b>\n${escapeHtml(product.planDetails || "Not set (use ⚡ PRESETS or 💎 PLAN SPECS)")}\n\n` +
    `📜 <b>Login guide & rules:</b>\n${escapeHtml(product.deliveryInstructions || "Not set (use ⚡ PRESETS or 📜 LOGIN GUIDE)")}\n\n` +
    `📝 <b>Description:</b>\n${escapeHtml(product.description || "No description")}`;
  await editOrReply(ctx, text, productDetailKeyboard(product), deps.logger);
}

export async function showProductPresetsAdmin(
  ctx: BotContext,
  deps: BotDependencies,
  productId: string,
): Promise<void> {
  const product = await getProduct(deps.database.prisma, productId);
  const text = `⚡ <b>${smallCaps("Delivery presets")} · ${escapeHtml(product.name)}</b>\n\n` +
    `${smallCaps("Choose a 1-click preset to automatically configure Account/Plan Specs, 24h Warranty, and Buyer Login Rules (e.g. for Crunchyroll, Netflix, Spotify, Steam, or License Keys), or customize each field manually.")}\n\n` +
    `💎 <b>Current specs:</b> ${escapeHtml(product.planDetails || "None")}\n` +
    `🛡 <b>Current warranty:</b> ${product.warrantyHours}h`;
  await editOrReply(ctx, text, productPresetsKeyboard(product.id), deps.logger);
}

export async function showInventoryAdmin(ctx: BotContext, deps: BotDependencies): Promise<void> {
  const categories = await listCategories(deps.database.prisma);
  await editOrReply(
    ctx,
    `📋 <b>${smallCaps("Inventory")}</b>\n\n${smallCaps("Select a category, then a product to add, inspect, export, or clear stock.")}\n\n${smallCaps("Supports classic email:pass or rich lines like:")}\n<code>email:pass | Plan: Mega Fan | Expiry: 2027-01-15 | Profile: #2</code>`,
    inventoryCategoriesKeyboard(categories),
    deps.logger,
  );
}

export async function showInventoryProducts(
  ctx: BotContext,
  deps: BotDependencies,
  categoryId: string,
): Promise<void> {
  const category = await deps.database.prisma.category.findFirst({ where: { id: categoryId, deletedAt: null } });
  if (!category) {
    await editOrReply(ctx, "That category no longer exists.", adminBackKeyboard(), deps.logger);
    return;
  }
  const result = await listCategoryProducts(deps.database.prisma, categoryId, 0, 100, true);
  await editOrReply(
    ctx,
    `📋 <b>${escapeHtml(category.name)} inventory</b>\n\nChoose a product to inspect or add stock.`,
    inventoryProductsKeyboard(result.products, categoryId),
    deps.logger,
  );
}

export async function showInventoryList(
  ctx: BotContext,
  deps: BotDependencies,
  productId: string,
  page: number,
): Promise<void> {
  const product = await getProduct(deps.database.prisma, productId);
  const [items, total] = await Promise.all([
    listAvailableInventory(deps.database.prisma, productId, page * PAGE_SIZE, PAGE_SIZE),
    deps.database.prisma.inventoryItem.count({ where: { productId, status: "AVAILABLE" } }),
  ]);
  const keyboard = new InlineKeyboard();
  for (const item of items) {
    keyboard
      .text(`👁 ${item.id.slice(0, 8)} · ${formatDate(item.createdAt)}`.slice(0, 46), `admin:stock:peek:${item.id}`)
      .text("🗑", `admin:stock:remove:${item.id}`)
      .row();
  }
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (page > 0) keyboard.text("◀", `admin:stock:list:${productId}:${page - 1}`);
  keyboard.text(`${page + 1}/${pages}`, "noop");
  if (page + 1 < pages) keyboard.text("▶", `admin:stock:list:${productId}:${page + 1}`);
  keyboard.row()
    .text("➕ ADD STOCK", `admin:stock:add:${productId}`)
    .text("📤 EXPORT .TXT", `admin:stock:export:${productId}`);
  if (total > 0) {
    keyboard.row().text("🧹 CLEAR ALL STOCK", `admin:stock:clear:${productId}`);
  }
  keyboard.row().text("◀ PRODUCT", `admin:product:view:${productId}`);
  const text = items.length
    ? `📋 <b>${escapeHtml(product.name)} · available items</b>\n\n${total} item(s). Tap 👁 on an item to inspect its credentials/details, or 🗑 to remove it.\n\n${items.map((item) => `• <code>${item.id.slice(0, 8)}</code> · ${escapeHtml(formatDate(item.createdAt))}`).join("\n")}`
    : `📋 <b>${escapeHtml(product.name)} · inventory</b>\n\nNo available items. Add authorized stock to make this product purchasable.`;
  await editOrReply(ctx, text, keyboard, deps.logger);
}

export async function showInventoryItemPeek(
  ctx: BotContext,
  deps: BotDependencies,
  itemId: string,
): Promise<void> {
  const item = await getAvailableInventoryItem(deps.database.prisma, itemId);
  const keyboard = new InlineKeyboard()
    .text("🗑 REMOVE THIS ITEM", `admin:stock:remove:${item.id}`)
    .row()
    .text("◀ BACK TO STOCK LIST", `admin:stock:list:${item.productId}:0`);
  const text = `👁 <b>${smallCaps("Stock item inspector")}</b>\n\n` +
    `<b>Product:</b> ${escapeHtml(item.product.emoji)} ${escapeHtml(item.product.name)}\n` +
    `<b>Item ID:</b> <code>${escapeHtml(item.id.slice(0, 8))}</code>\n` +
    `<b>Added:</b> ${escapeHtml(formatDate(item.createdAt))}\n\n` +
    `<b>Parsed buyer preview:</b>\n${renderParsedPayloadBlock(item.payload)}`;
  await editOrReply(ctx, text, keyboard, deps.logger);
}

export async function showWarrantyClaimsAdmin(
  ctx: BotContext,
  deps: BotDependencies,
  page: number,
): Promise<void> {
  const result = await listWarrantyClaims(deps.database.prisma, page, PAGE_SIZE);
  const keyboard = new InlineKeyboard();
  for (const claim of result.claims) {
    const icon = claim.status === "PENDING" ? "⏳"
      : claim.status === "REPLACED" ? "🔄"
      : claim.status === "REFUNDED" ? "💳"
      : "❌";
    const buyerLabel = claim.buyer.username ? `@${claim.buyer.username}` : claim.buyer.firstName ?? "Buyer";
    keyboard.text(
      `${icon} ${claim.product.name} · ${buyerLabel}`.slice(0, 58),
      `admin:warranty:view:${claim.id}`,
    ).row();
  }
  if (page > 0) keyboard.text("◀", `admin:warranty:${page - 1}`);
  keyboard.text(`${page + 1}/${result.pages}`, "noop");
  if (page + 1 < result.pages) keyboard.text("▶", `admin:warranty:${page + 1}`);
  keyboard.row().text("◀ ADMIN", "admin:panel");

  const lines = result.claims.map((claim) => {
    const buyerLabel = claim.buyer.username
      ? `@${escapeHtml(claim.buyer.username)}`
      : `ID <code>${claim.buyer.telegramId.toString()}</code>`;
    return `• <b>[${claim.status}]</b> ${escapeHtml(claim.product.emoji)} ${escapeHtml(claim.product.name)} · ${buyerLabel}\n  Reason: <i>${escapeHtml(claim.reason)}</i>`;
  });

  await editOrReply(
    ctx,
    `🛡 <b>${smallCaps("Warranty & Replacement Claims")}</b>\n\n` +
      `${result.pendingCount} pending · ${result.total} total\n\n` +
      `${lines.join("\n\n") || "No warranty claims submitted yet."}`,
    keyboard,
    deps.logger,
  );
}

export async function showWarrantyClaimDetail(
  ctx: BotContext,
  deps: BotDependencies,
  claimId: string,
): Promise<void> {
  const claim = await getWarrantyClaimDetail(deps.database.prisma, claimId);
  const buyerLabel = claim.buyer.username
    ? `@${escapeHtml(claim.buyer.username)} (<code>${claim.buyer.telegramId.toString()}</code>)`
    : `<code>${claim.buyer.telegramId.toString()}</code>`;

  const keyboard = new InlineKeyboard();
  if (claim.status === "PENDING") {
    keyboard
      .text("🔄 REPLACE FROM STOCK", `admin:warranty:replace:${claim.id}`)
      .row()
      .text("❌ REJECT ISSUE", `admin:warranty:reject:${claim.id}`)
      .row();
  }
  keyboard.text("◀ WARRANTY CLAIMS", "admin:warranty:0");

  const text = `🛡 <b>${smallCaps("Warranty Claim")}</b> · <code>#${escapeHtml(claim.id.slice(0, 8))}</code>\n\n` +
    `<b>Status:</b> ${claim.status}\n` +
    `<b>Buyer:</b> ${buyerLabel}\n` +
    `<b>Product:</b> ${escapeHtml(claim.product.emoji)} ${escapeHtml(claim.product.name)}\n` +
    `<b>Order ID:</b> <code>#${escapeHtml(claim.purchaseId.slice(0, 8))}</code> (${creditLabel(claim.purchase.amountPaid)})\n` +
    `<b>Submitted:</b> ${escapeHtml(formatDate(claim.createdAt))}\n` +
    `<b>Reported issue:</b> ${escapeHtml(claim.reason)}\n` +
    (claim.resolutionNote ? `<b>Resolution:</b> ${escapeHtml(claim.resolutionNote)}\n` : "") +
    `\n<b>Current delivered item:</b>\n${renderParsedPayloadBlock(claim.purchase.inventoryItem.payload)}\n\n` +
    `<i>Refunds are not offered. Pending claims can only be replaced from available stock or rejected.</i>`;

  await editOrReply(ctx, text, keyboard, deps.logger);
}

export async function showUsersAdmin(ctx: BotContext, deps: BotDependencies, page: number): Promise<void> {
  const result = await listUsersPage(deps.database.prisma, page, PAGE_SIZE);
  const keyboard = userPaginationKeyboard(page, result.pages);
  for (const user of result.users) {
    keyboard.row().text(
      `${user.username ? `@${user.username}` : user.firstName ?? "User"} · ${user.credits}c`.slice(0, 60),
      `admin:user:${user.id}`,
    );
  }
  const lines = result.users.map((user) =>
    `• ${user.username ? `@${escapeHtml(user.username)}` : escapeHtml(user.firstName ?? "User")} · <code>${user.telegramId.toString()}</code> · ${user.credits}c\n  Active ${escapeHtml(formatDate(user.lastActiveAt))} · Joined ${escapeHtml(formatDate(user.createdAt))}`,
  );
  await editOrReply(
    ctx,
    `👥 <b>${smallCaps("Users")}</b> · ${result.total}\n\n${lines.join("\n\n") || "No users yet."}`,
    keyboard,
    deps.logger,
  );
}

export async function showUserDetail(ctx: BotContext, deps: BotDependencies, userId: string): Promise<void> {
  const user = await deps.database.prisma.user.findUnique({
    where: { id: userId },
    include: { _count: { select: { purchases: true, creditTransactions: true } } },
  });
  if (!user) {
    await editOrReply(ctx, "That user no longer exists.", adminBackKeyboard(), deps.logger);
    return;
  }
  const text = `👤 <b>${escapeHtml([user.firstName, user.lastName].filter(Boolean).join(" ") || "Iris user")}</b>\n\n` +
    `<b>Username:</b> ${user.username ? `@${escapeHtml(user.username)}` : "Not set"}\n` +
    `<b>Telegram ID:</b> <code>${user.telegramId.toString()}</code>\n` +
    `<b>Credits:</b> ${creditLabel(user.credits)}\n` +
    `<b>Purchases:</b> ${user._count.purchases}\n` +
    `<b>Transactions:</b> ${user._count.creditTransactions}\n` +
    `<b>Joined:</b> ${escapeHtml(formatDate(user.createdAt))}\n` +
    `<b>Last active:</b> ${escapeHtml(formatDate(user.lastActiveAt))}`;
  const keyboard = new InlineKeyboard()
    .text("🎁 GIFT 10", `admin:user:gift:${user.id}:10`)
    .text("−10", `admin:user:remove:${user.id}:10`)
    .row()
    .text("◀ USERS", "admin:users:0");
  await editOrReply(ctx, text, keyboard, deps.logger);
}

export async function showCodesAdmin(ctx: BotContext, deps: BotDependencies, page: number): Promise<void> {
  const [codes, total] = await Promise.all([
    listRedeemCodes(deps.database.prisma, page * PAGE_SIZE, PAGE_SIZE),
    deps.database.prisma.redeemCode.count(),
  ]);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  await editOrReply(
    ctx,
    `🔑 <b>${smallCaps("Redeem codes")}</b> · ${total}\n\nUse /code AMOUNT CREDITS MAXREDEEMS to create a batch.`,
    codeListKeyboard(codes, page, pages),
    deps.logger,
  );
}

export async function showCodeDetail(ctx: BotContext, deps: BotDependencies, codeId: string): Promise<void> {
  const code = await deps.database.prisma.redeemCode.findUnique({
    where: { id: codeId },
    include: { _count: { select: { redemptions: true } } },
  });
  if (!code) {
    await editOrReply(ctx, "That code no longer exists.", adminBackKeyboard(), deps.logger);
    return;
  }
  const keyboard = new InlineKeyboard()
    .text(code.enabled ? "⏸ DISABLE" : "▶ ENABLE", `admin:code:toggle:${code.id}`)
    .row()
    .text("◀ CODES", "admin:codes:0");
  await editOrReply(
    ctx,
    `🔑 <b>${escapeHtml(code.code)}</b>\n\n` +
      `<b>Credits per redemption:</b> ${creditLabel(code.creditAmount)}\n` +
      `<b>Redemptions:</b> ${code.currentRedeems}/${code.maxRedeems}\n` +
      `<b>Status:</b> ${code.enabled ? "Enabled" : "Disabled"}\n` +
      `<b>Expires:</b> ${escapeHtml(formatDate(code.expiresAt))}\n` +
      `<b>Recorded redemptions:</b> ${code._count.redemptions}`,
    keyboard,
    deps.logger,
  );
}

export async function showStatistics(ctx: BotContext, deps: BotDependencies): Promise<void> {
  const stats = await getStoreStatistics(deps.database.prisma);
  const recent = stats.recentPurchases.map((purchase) =>
    `• ${escapeHtml(purchase.product.emoji)} ${escapeHtml(purchase.product.name)} — ${creditLabel(purchase.amountPaid)} · ${purchase.buyer.username ? `@${escapeHtml(purchase.buyer.username)}` : `ID ${purchase.buyer.telegramId.toString()}`}`,
  );
  const text = `📊 <b>${smallCaps("Store statistics")}</b>\n\n` +
    `👥 Users: ${stats.users}\n` +
    `🟢 Active 24h: ${stats.active24h}\n` +
    `🟢 Active 72h: ${stats.active72h}\n` +
    `📦 Products: ${stats.products}\n` +
    `📋 Available inventory: ${stats.inventory}\n` +
    `🧾 Purchases: ${stats.purchases}\n` +
    `✦ Credits issued (net): ${stats.creditsIssued.toLocaleString("en-US")}\n` +
    `💳 Spent / revenue-equivalent: ${stats.creditsSpent.toLocaleString("en-US")} credits\n\n` +
    `<b>${smallCaps("Recent purchases")}</b>\n${recent.join("\n") || "None yet."}`;
  await editOrReply(
    ctx,
    text,
    new InlineKeyboard().text("👥 USERS", "admin:users:0").text("🧾 PURCHASES", "admin:purchases:0").row().text("◀ ADMIN", "admin:panel"),
    deps.logger,
  );
}

export async function showPurchasesAdmin(ctx: BotContext, deps: BotDependencies, page: number): Promise<void> {
  const skip = Math.max(0, page) * PAGE_SIZE;
  const [purchases, total] = await Promise.all([
    deps.database.prisma.purchase.findMany({
      orderBy: { createdAt: "desc" },
      skip,
      take: PAGE_SIZE,
      include: {
        buyer: { select: { telegramId: true, username: true } },
        product: { select: { name: true, emoji: true } },
      },
    }),
    deps.database.prisma.purchase.count(),
  ]);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const keyboard = new InlineKeyboard();
  if (page > 0) keyboard.text("◀", `admin:purchases:${page - 1}`);
  keyboard.text(`${page + 1}/${pages}`, "noop");
  if (page + 1 < pages) keyboard.text("▶", `admin:purchases:${page + 1}`);
  keyboard.row().text("◀ ADMIN", "admin:panel");
  const lines = purchases.map((purchase) =>
    `• ${escapeHtml(purchase.product.emoji)} ${escapeHtml(purchase.product.name)} · ${creditLabel(purchase.amountPaid)}\n  ${purchase.buyer.username ? `@${escapeHtml(purchase.buyer.username)}` : `ID ${purchase.buyer.telegramId.toString()}`} · ${escapeHtml(formatDate(purchase.createdAt))}`,
  );
  await editOrReply(ctx, `🧾 <b>${smallCaps("Purchases")}</b> · ${total}\n\n${lines.join("\n\n") || "No purchases yet."}`, keyboard, deps.logger);
}

export async function showCreditsManagement(ctx: BotContext, deps: BotDependencies): Promise<void> {
  const text = `🎁 <b>${smallCaps("Credit management")}</b>\n\n` +
    `Use these owner commands:\n` +
    `• /gift USER_ID CREDITS\n` +
    `• /rm USER_ID CREDITS\n` +
    `• /giftall CREDITS — users active in the last 72 hours\n` +
    `• /code AMOUNT CREDITS MAXREDEEMS\n\n` +
    `${smallCaps("Every balance change is written to the credit ledger.")}`;
  await editOrReply(ctx, text, adminBackKeyboard(), deps.logger);
}

export async function showSettings(ctx: BotContext, deps: BotDependencies): Promise<void> {
  const settings = await deps.database.prisma.appSetting.findMany({ orderBy: { key: "asc" } });
  const bonus = await import("../services/settings.service.js").then(({ getBonusSettings }) =>
    getBonusSettings(deps.database.prisma, {
      credits: deps.config.bonusCredits,
      periodHours: deps.config.bonusPeriodHours,
    }),
  );
  const stored = settings.length ? settings.map((item) => `${escapeHtml(item.key)}: ${escapeHtml(item.value)}`).join("\n") : "No custom settings.";
  await editOrReply(
    ctx,
    `⚙️ <b>${smallCaps("Settings")}</b>\n\n` +
      `<b>Owner ID:</b> <code>${deps.config.ownerId.toString()}</code>\n` +
      `<b>Daily bonus:</b> ${creditLabel(bonus.credits)} every ${bonus.periodHours}h\n` +
      `<b>Bonus configuration:</b> environment defaults with owner overrides\n\n` +
      `<b>Stored settings</b>\n${stored}`,
    new InlineKeyboard().text("🎁 EDIT BONUS SETTINGS", "admin:settings:bonus").row().text("◀ ADMIN", "admin:panel"),
    deps.logger,
  );
}

export function getCodePages(total: number): number {
  return Math.max(1, Math.ceil(total / PAGE_SIZE));
}
