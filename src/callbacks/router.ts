import { randomBytes } from "node:crypto";
import { InlineKeyboard, InputFile } from "grammy";
import type { Bot } from "grammy";
import type { BotContext } from "../types/context.js";
import type { BotDependencies } from "../bot/dependencies.js";
import { isOwner, requirePrivate } from "../bot/authorization.js";
import { adminPanelKeyboard, confirmDangerKeyboard, confirmPurchaseKeyboard, mainKeyboard } from "../keyboards/inline.js";
import {
  showAdminPanel,
  showCategoriesAdmin,
  showCategoryAdmin,
  showCategoryProductsAdmin,
  showProductsAdmin,
  showProductAdmin,
  showProductPresetsAdmin,
  showInventoryAdmin,
  showInventoryProducts,
  showInventoryList,
  showInventoryItemPeek,
  showWarrantyClaimsAdmin,
  showWarrantyClaimDetail,
  showUsersAdmin,
  showUserDetail,
  showCodesAdmin,
  showCodeDetail,
  showStatistics,
  showPurchasesAdmin,
  showCreditsManagement,
  showSettings,
} from "../bot/admin-views.js";
import {
  claimBonus,
  sendOrderReceiptFile,
  showBonusStatus,
  showCategory,
  showFeaturedStore,
  showHelp,
  showHome,
  showOrderDetail,
  showOrders,
  showWallet,
  showProduct,
  showProfile,
  showStore,
  showWarrantyPrompt,
} from "../bot/views.js";
import { editMessageRichOrLegacy, editOrReply, editOrReplyRich, replyRichOrLegacy, sendRichOrLegacy } from "../bot/render.js";
import { beginAdminFlow, handleUserWarrantySubmission } from "../commands/admin-flow.js";
import { beginReset, cancelReset, completeReset, continueReset, requestRestart, sendStoreExport } from "../commands/admin.js";
import { broadcastToUsers } from "../services/broadcast.service.js";
import { changeCredits } from "../services/credits.service.js";
import {
  purchaseProduct,
  resolveWarrantyClaimReject,
  resolveWarrantyClaimReplace,
} from "../services/purchases.service.js";
import type { PurchaseResult } from "../services/purchases.service.js";
import {
  applyProductPreset,
  archiveCategory,
  archiveProduct,
  clearAvailableInventory,
  cloneProduct,
  getProduct,
  listAllAvailablePayloads,
  listCategories,
  removeInventoryItem,
  reorderCategory,
  toggleStockSubscription,
  updateCategory,
  updateProduct,
} from "../services/store.service.js";
import { setRedeemCodeEnabled } from "../services/codes.service.js";
import { findUserByTelegramId } from "../services/users.service.js";
import { creditLabel, escapeFilenamePart, escapeHtml, smallCaps } from "../utils/format.js";
import { DomainError, NotFoundError, PriceChangedError, ValidationError } from "../utils/errors.js";
import {
  productMessage,
  purchaseDeliveryMessage,
  renderParsedPayloadBlock,
  richCredentialBlocks,
  richPurchaseConfirmationMessage,
  richPurchaseDeliveryMessage,
} from "../messages/iris.js";
import {
  richButtonRow,
  richCallbackButton,
  richHeading,
  richKeyValueTable,
  richParagraph,
} from "../messages/rich-ui.js";

function adminKeyboardFor(data: string) {
  return data.startsWith("admin:") || data.startsWith("reset:") ? adminPanelKeyboard() : mainKeyboard();
}

const QUICK_WARRANTY_REASONS: Record<string, string> = {
  invalid_creds: "Invalid email or password when attempting to log in",
  locked: "Account is locked, suspended, or requires 2FA verification",
  expired: "Account subscription/plan is expired or showing free tier",
};

async function showPurchaseConfirmation(
  ctx: BotContext,
  deps: BotDependencies,
  productId: string,
  quantity = 1,
): Promise<void> {
  const product = await getProduct(deps.database.prisma, productId);
  const user = await deps.database.prisma.user.findUnique({ where: { telegramId: BigInt(ctx.from!.id) } });
  if (!user) throw new NotFoundError("Send /start first so Iris can create your profile.");
  if (!product.enabled || product.deletedAt || !product.category.enabled || product.category.deletedAt) {
    ctx.session.purchaseConfirmation = null;
    await editOrReply(ctx, smallCaps("This product is no longer available."), mainKeyboard(), deps.logger);
    return;
  }
  if (product._count.inventory <= 0) {
    ctx.session.purchaseConfirmation = null;
    await editOrReply(ctx, smallCaps("⚠️ This product is out of stock right now."), new InlineKeyboard().text(smallCaps("◀ STORE"), `store:category:${product.categoryId}:0`), deps.logger);
    return;
  }
  const maxAvailable = product.isUnlimited ? 5 : Math.min(5, product._count.inventory);
  const safeQty = Math.max(1, Math.min(quantity, maxAvailable));
  const totalCost = product.price * safeQty;
  const qtyNote = safeQty > 1
    ? `\n📦 <b>${smallCaps("Quantity")}:</b> ${safeQty}x (${creditLabel(totalCost)} total)`
    : "";
  const card = {
    emoji: product.emoji,
    name: product.name,
    category: product.category.name,
    description: product.description,
    planDetails: product.planDetails,
    warrantyHours: product.warrantyHours,
    featured: product.featured,
    isUnlimited: product.isUnlimited,
    price: product.price,
    stock: product._count.inventory,
    credits: user.credits,
  };
  const canAfford = user.credits >= totalCost;
  const text = `${productMessage(card)}${qtyNote}\n\n` +
    (canAfford
      ? `🛒 <b>${smallCaps("Confirm this purchase?")}</b>\n${smallCaps("Credits are charged only if stock is assigned. All sales are final; no refunds.")}`
      : `⚠️ ${smallCaps("You need")} ${creditLabel(totalCost - user.credits)} ${smallCaps("more to buy this item.")}`);
  const nonce = ctx.session.purchaseConfirmation?.productId === product.id
    ? ctx.session.purchaseConfirmation.nonce
    : randomBytes(8).toString("hex");
  ctx.session.purchaseConfirmation = {
    productId: product.id,
    nonce,
    telegramId: ctx.from!.id,
    expectedPrice: product.price,
    quantity: safeQty,
    expiresAt: Date.now() + 2 * 60 * 1_000,
  };
  const backData = `store:product:${product.id}`;
  const keyboard = canAfford
    ? confirmPurchaseKeyboard(product.id, nonce, product.price, safeQty, maxAvailable)
    : new InlineKeyboard().text(smallCaps("🎁 Claim bonus"), "nav:bonus").row().text(smallCaps("◀ Back to item"), backData);
  const richActionRows: Array<Array<ReturnType<typeof richCallbackButton>>> = [];
  if (canAfford) {
    if (maxAvailable >= 2) {
      richActionRows.push([1, 2, 3, 5]
        .filter((qty) => qty <= maxAvailable)
        .map((qty) => richCallbackButton(
          qty === safeQty ? `✓ ${qty}×` : `${qty}×`,
          `buy:qty:${product.id}:${qty}`,
          qty === safeQty ? "primary" : undefined,
        )));
    }
    richActionRows.push([
      richCallbackButton("🛒 Confirm purchase", `buy:confirm:${product.id}:${nonce}:${product.price.toString(36)}`, "success"),
      richCallbackButton("◀ Back to item", backData, "link"),
    ]);
  } else {
    richActionRows.push([
      richCallbackButton("🎁 Claim daily bonus", "nav:bonus", "primary"),
      richCallbackButton("◀ Back to item", backData, "link"),
    ]);
  }
  await editOrReplyRich(
    ctx,
    richPurchaseConfirmationMessage({
      emoji: product.emoji,
      name: product.name,
      category: product.category.name,
      price: product.price,
      stock: product._count.inventory,
      credits: user.credits,
      quantity: safeQty,
      isUnlimited: product.isUnlimited,
    }, richActionRows),
    text,
    { fallbackKeyboard: keyboard, logger: deps.logger },
  );
}

async function handleUserCallback(ctx: BotContext, deps: BotDependencies, data: string): Promise<boolean> {
  if (data === "nav:home") await showHome(ctx, deps);
  else if (data === "nav:store") await showStore(ctx, deps);
  else if (data === "nav:profile") await showProfile(ctx, deps);
  else if (data === "nav:wallet") await showWallet(ctx, deps);
  else if (data === "nav:bonus") await showBonusStatus(ctx, deps);
  else if (data === "nav:orders") await showOrders(ctx, deps);
  else if (data === "nav:help") await showHelp(ctx, deps);
  else if (data === "bonus:claim") await claimBonus(ctx, deps, true);
  else if (data === "noop") return true;
  else if (data.startsWith("orders:page:")) {
    const page = Number(data.split(":")[2] ?? 0);
    await showOrders(ctx, deps, page);
  } else if (data.startsWith("wallet:page:")) {
    const page = Number(data.split(":")[2] ?? 0);
    await showWallet(ctx, deps, page);
  } else if (data.startsWith("order:view:")) {
    const purchaseId = data.split(":")[2];
    if (!purchaseId) throw new Error("Order link is invalid.");
    await showOrderDetail(ctx, deps, purchaseId);
  } else if (data.startsWith("order:txt:")) {
    const purchaseId = data.split(":")[2];
    if (!purchaseId) throw new Error("Order link is invalid.");
    await sendOrderReceiptFile(ctx, deps, purchaseId);
  } else if (data.startsWith("order:warranty:")) {
    const purchaseId = data.split(":")[2];
    if (!purchaseId) throw new Error("Order link is invalid.");
    await showWarrantyPrompt(ctx, deps, purchaseId);
  } else if (data.startsWith("order:claim:")) {
    const parts = data.split(":");
    const purchaseId = parts[2];
    const reasonKey = parts[3];
    const reason = reasonKey ? QUICK_WARRANTY_REASONS[reasonKey] : undefined;
    if (!purchaseId || !reason) throw new Error("Invalid warranty claim option.");
    await handleUserWarrantySubmission(ctx, deps, purchaseId, reason);
  } else if (data.startsWith("store:featured:")) {
    const page = Number(data.split(":")[2] ?? 0);
    await showFeaturedStore(ctx, deps, page);
  } else if (data === "store:search:start") {
    ctx.session.userFlow = { kind: "store:search" };
    await editOrReply(
      ctx,
      `🔍 <b>${smallCaps("Search Iris store")}</b>\n\n${smallCaps("Send a keyword, for example")} <code>crunchyroll</code>, <code>netflix</code>, <code>premium</code> ${smallCaps("or tap below to go back.")}`,
      new InlineKeyboard().text(smallCaps("◀ STORE"), "nav:store").text(smallCaps("🏠 HOME"), "nav:home"),
      deps.logger,
    );
  } else if (data.startsWith("store:notify:")) {
    const productId = data.split(":")[2];
    if (!productId) throw new Error("That product link is invalid.");
    const user = await findUserByTelegramId(deps.database.prisma, ctx.from!.id);
    await toggleStockSubscription(deps.database.prisma, user.id, productId);
    await showProduct(ctx, deps, productId);
  } else if (data.startsWith("store:banner:")) {
    const productId = data.split(":")[2];
    if (!productId) throw new Error("That product link is invalid.");
    const product = await getProduct(deps.database.prisma, productId);
    if (product.mediaFileId) {
      const keyboard = new InlineKeyboard()
        .text(smallCaps("◀ Product"), `store:product:${product.id}`)
        .text(smallCaps("🏠 Home"), "nav:home");
      try {
        await ctx.replyWithRichMessage({
          blocks: [
            {
              type: "photo",
              photo: { type: "photo", media: product.mediaFileId },
              caption: { text: [smallCaps(`${product.emoji} `), product.name] },
            },
            richButtonRow([
              richCallbackButton("◀ Product", `store:product:${product.id}`, "link"),
              richCallbackButton("🏠 Home", "nav:home", "link"),
            ]),
          ],
        });
      } catch (error) {
        deps.logger.debug({ err: error }, "Rich product banner failed; using a standard photo message");
        await ctx.replyWithPhoto(product.mediaFileId, {
          caption: `${escapeHtml(product.emoji)} <b>${escapeHtml(product.name)}</b>`,
          parse_mode: "HTML",
          reply_markup: keyboard,
        });
      }
    }
  } else if (data.startsWith("store:category:")) {
    const [, , categoryId, page] = data.split(":");
    if (!categoryId) throw new Error("That category link is invalid.");
    await showCategory(ctx, deps, categoryId, Number(page ?? 0));
  } else if (data.startsWith("store:product:")) {
    const productId = data.split(":")[2];
    if (!productId) throw new Error("That product link is invalid.");
    await showProduct(ctx, deps, productId);
  } else if (data.startsWith("buy:start:")) {
    const productId = data.split(":")[2];
    if (!productId) throw new Error("That product link is invalid.");
    ctx.session.purchaseConfirmation = null;
    await showPurchaseConfirmation(ctx, deps, productId, 1);
  } else if (data.startsWith("buy:qty:")) {
    const [, , productId, rawQty] = data.split(":");
    if (!productId) throw new Error("That product link is invalid.");
    await showPurchaseConfirmation(ctx, deps, productId, Number(rawQty ?? 1));
  } else if (data.startsWith("buy:confirm:")) {
    const parts = data.split(":");
    const productId = parts[2];
    const nonce = parts[3];
    const encodedPrice = parts[4];
    const expectedPrice = encodedPrice && /^[0-9a-z]{1,6}$/.test(encodedPrice)
      ? Number.parseInt(encodedPrice, 36)
      : Number.NaN;
    const intent = ctx.session.purchaseConfirmation;
    if (
      parts.length !== 5 || !productId || !/^[a-z0-9_-]{1,64}$/.test(productId) ||
      !nonce || !/^[a-f0-9]{16}$/.test(nonce) || !Number.isSafeInteger(expectedPrice) ||
      expectedPrice < 0 || expectedPrice > 1_000_000_000 || expectedPrice.toString(36) !== encodedPrice ||
      !intent || intent.productId !== productId || intent.nonce !== nonce ||
      intent.telegramId !== ctx.from!.id || intent.expectedPrice !== expectedPrice || intent.expiresAt <= Date.now()
    ) {
      if (intent && intent.expiresAt <= Date.now()) ctx.session.purchaseConfirmation = null;
      throw new ValidationError("Purchase confirmation expired or doesn't belong to this account. Open the item again.");
    }
    const user = await deps.database.prisma.user.findUnique({ where: { telegramId: BigInt(ctx.from!.id) } });
    if (!user) throw new NotFoundError("Send /start first so Iris can create your profile.");
    let result: PurchaseResult;
    try {
      result = await purchaseProduct(
        deps.database.prisma,
        user.id,
        productId,
        `iris:${ctx.from!.id}:${nonce}`,
        expectedPrice,
        intent.quantity ?? 1,
      );
    } catch (error) {
      if (error instanceof PriceChangedError) ctx.session.purchaseConfirmation = null;
      throw error;
    }
    const receiptData = `order:txt:${result.purchaseId}`;
    const issueData = `order:warranty:${result.purchaseId}`;
    const keyboard = new InlineKeyboard()
      .text(smallCaps("📄 Download receipt"), receiptData)
      .text(smallCaps("🛠 Report issue"), issueData)
      .row()
      .text(smallCaps("🛍 Back to store"), "nav:store")
      .text(smallCaps("📦 My orders"), "nav:orders");
    const richActionRows = [
      [
        richCallbackButton("📄 Download receipt", receiptData, "primary"),
        richCallbackButton("🛠 Report issue", issueData, "danger"),
      ],
      [
        richCallbackButton("🛍 Back to store", "nav:store", "link"),
        richCallbackButton("📦 My orders", "nav:orders"),
      ],
    ];
    await editOrReplyRich(
      ctx,
      richPurchaseDeliveryMessage(result, richActionRows),
      purchaseDeliveryMessage(result),
      { fallbackKeyboard: keyboard, logger: deps.logger },
    );
    deps.logger.info({ telegramId: ctx.from!.id, productId, purchaseId: result.purchaseId, repeated: result.repeated }, "Digital product delivered");
  } else {
    return false;
  }
  return true;
}

async function handleAdminCallback(
  ctx: BotContext,
  deps: BotDependencies,
  bot: Bot<BotContext>,
  data: string,
): Promise<boolean> {
  const parts = data.split(":");

  if (data === "admin:panel") await showAdminPanel(ctx, deps);
  else if (data === "admin:categories") await showCategoriesAdmin(ctx, deps);
  else if (data === "admin:category:add") {
    await beginAdminFlow(ctx, deps, { kind: "category:create:name" }, `🗂 <b>${smallCaps("New category")}</b>\n\n${smallCaps("Send the category name (2–80 characters).")}`);
  } else if (parts[1] === "category" && parts[2] === "view" && parts[3]) {
    await showCategoryAdmin(ctx, deps, parts[3]);
  } else if (parts[1] === "category" && parts[2] === "toggle" && parts[3]) {
    const category = await deps.database.prisma.category.findFirst({ where: { id: parts[3], deletedAt: null } });
    if (!category) throw new NotFoundError("That category no longer exists.");
    await updateCategory(deps.database.prisma, category.id, { enabled: !category.enabled });
    await showCategoryAdmin(ctx, deps, category.id);
  } else if (parts[1] === "category" && parts[2] === "rename" && parts[3]) {
    await beginAdminFlow(ctx, deps, { kind: "category:edit:name", categoryId: parts[3] }, `✏️ ${smallCaps("Send the new category name.")}`);
  } else if (parts[1] === "category" && parts[2] === "description" && parts[3]) {
    await beginAdminFlow(ctx, deps, { kind: "category:edit:description", categoryId: parts[3] }, `📝 ${smallCaps("Send the category description (up to 500 characters), or /skip to clear it.")}`);
  } else if (parts[1] === "category" && parts[2] === "emoji" && parts[3]) {
    await beginAdminFlow(ctx, deps, { kind: "category:edit:emoji", categoryId: parts[3] }, `🎨 ${smallCaps("Send the new category icon or emoji.")}`);
  } else if (parts[1] === "category" && parts[2] === "reorder" && parts[3] && parts[4]) {
    const direction = Number(parts[4]);
    if (direction !== -1 && direction !== 1) throw new Error("Invalid category order action.");
    await reorderCategory(deps.database.prisma, parts[3], direction);
    await showCategoriesAdmin(ctx, deps);
  } else if (parts[1] === "category" && parts[2] === "delete" && parts[3]) {
    const category = await deps.database.prisma.category.findFirst({
      where: { id: parts[3], deletedAt: null },
      include: { _count: { select: { products: { where: { deletedAt: null } } } } },
    });
    if (!category) throw new NotFoundError("That category no longer exists.");
    await editOrReply(
      ctx,
      `⚠️ <b>${smallCaps("Archive")} ${escapeHtml(category.name)}?</b>\n\n${smallCaps("This hides the category and disables/archives its")} ${category._count.products} ${smallCaps("product(s). Existing purchase history remains.")}`,
      confirmDangerKeyboard(`admin:category:deleteconfirm:${category.id}`, `admin:category:view:${category.id}`),
      deps.logger,
    );
  } else if (parts[1] === "category" && parts[2] === "deleteconfirm" && parts[3]) {
    await archiveCategory(deps.database.prisma, parts[3]);
    await showCategoriesAdmin(ctx, deps);
  } else if (data.startsWith("admin:category:products:")) {
    const categoryId = parts[3];
    if (!categoryId) throw new Error("Category link is invalid.");
    await showCategoryProductsAdmin(ctx, deps, categoryId, Number(parts[4] ?? 0));
  } else if (parts[1] === "product" && parts[2] === "add" && parts[3]) {
    await beginAdminFlow(ctx, deps, { kind: "product:create:name", categoryId: parts[3] }, `📦 <b>${smallCaps("Add product")}</b>\n\n${smallCaps("Send a product name (2–120 characters).")}`);
  } else if (data.startsWith("admin:products:")) {
    await showProductsAdmin(ctx, deps, Number(parts[2] ?? 0));
  } else if (parts[1] === "product" && parts[2] === "view" && parts[3]) {
    await showProductAdmin(ctx, deps, parts[3]);
  } else if (parts[1] === "product" && parts[2] === "presets" && parts[3]) {
    await showProductPresetsAdmin(ctx, deps, parts[3]);
  } else if (parts[1] === "product" && parts[2] === "preset" && parts[3] && parts[4]) {
    await applyProductPreset(deps.database.prisma, parts[3], parts[4]);
    await showProductAdmin(ctx, deps, parts[3]);
  } else if (parts[1] === "product" && parts[2] === "featured" && parts[3]) {
    const product = await getProduct(deps.database.prisma, parts[3]);
    await updateProduct(deps.database.prisma, product.id, { featured: !product.featured });
    await showProductAdmin(ctx, deps, product.id);
  } else if (parts[1] === "product" && parts[2] === "unlimited" && parts[3]) {
    const product = await getProduct(deps.database.prisma, parts[3]);
    await updateProduct(deps.database.prisma, product.id, { isUnlimited: !product.isUnlimited });
    await showProductAdmin(ctx, deps, product.id);
  } else if (parts[1] === "product" && parts[2] === "clone" && parts[3]) {
    const cloned = await cloneProduct(deps.database.prisma, parts[3]);
    await showProductAdmin(ctx, deps, cloned.id);
  } else if (parts[1] === "product" && parts[2] === "edit" && parts[3] && parts[4]) {
    const kind = parts[3];
    const productId = parts[4];
    const flow = kind === "name" ? { kind: "product:edit:name" as const, productId }
      : kind === "description" ? { kind: "product:edit:description" as const, productId }
      : kind === "plan" ? { kind: "product:edit:planDetails" as const, productId }
      : kind === "instructions" ? { kind: "product:edit:instructions" as const, productId }
      : kind === "warranty" ? { kind: "product:edit:warranty" as const, productId }
      : kind === "media" ? { kind: "product:edit:media" as const, productId }
      : kind === "price" ? { kind: "product:edit:price" as const, productId }
      : kind === "emoji" ? { kind: "product:edit:emoji" as const, productId }
      : null;
    if (!flow) throw new Error("Unknown product field.");
    const prompts: Record<string, string> = {
      name: `✏️ ${smallCaps("Send the new product name.")}`,
      description: `📝 ${smallCaps("Send the new description, or /skip to clear it.")}`,
      plan: `💎 ${smallCaps("Send the account / plan specs shown on the product card and receipt (for example:")} <code>Mega Fan · Ad-Free · 4K · 30 Days</code>${smallCaps("). Or /skip to clear it.")}`,
      instructions: `📜 ${smallCaps("Send the login guide and rules delivered to buyers upon purchase (for example:")} <code>• Do NOT change password\n• Use 1 screen</code>${smallCaps("). Or /skip to clear it.")}`,
      warranty: `🛡 ${smallCaps("Send the replacement warranty window in whole hours (0–8,760). For example:")} <code>24</code> ${smallCaps("for 24 hours,")} <code>720</code> ${smallCaps("for 30 days, or")} <code>0</code> ${smallCaps("for no warranty.")}`,
      media: `🖼 ${smallCaps("Upload a photo to set as the product banner, or send /skip to remove the current banner.")}`,
      price: `💳 ${smallCaps("Send the new whole-credit price (0–1,000,000,000).")}`,
      emoji: `🎨 ${smallCaps("Send the new product icon, or /skip to use ✦.")}`,
    };
    await beginAdminFlow(ctx, deps, flow, prompts[kind]!);
  } else if (parts[1] === "product" && parts[2] === "toggle" && parts[3]) {
    const product = await getProduct(deps.database.prisma, parts[3]);
    await updateProduct(deps.database.prisma, product.id, { enabled: !product.enabled });
    await showProductAdmin(ctx, deps, product.id);
  } else if (parts[1] === "product" && parts[2] === "category" && parts[3]) {
    const product = await getProduct(deps.database.prisma, parts[3]);
    const categories = await listCategories(deps.database.prisma);
    const keyboard = new InlineKeyboard();
    for (const category of categories) keyboard.text(smallCaps(`${category.emoji} ${category.name}`).slice(0, 55), `admin:product:move:${product.id}:${category.id}`).row();
    keyboard.text(smallCaps("◀ PRODUCT"), `admin:product:view:${product.id}`);
    await editOrReply(ctx, `🗂 <b>${smallCaps("Move")} ${escapeHtml(product.name)}</b>\n\n${smallCaps("Choose a category.")}`, keyboard, deps.logger);
  } else if (parts[1] === "product" && parts[2] === "move" && parts[3] && parts[4]) {
    await updateProduct(deps.database.prisma, parts[3], { categoryId: parts[4] });
    await showProductAdmin(ctx, deps, parts[3]);
  } else if (parts[1] === "product" && parts[2] === "delete" && parts[3]) {
    const product = await getProduct(deps.database.prisma, parts[3]);
    await editOrReply(
      ctx,
      `⚠️ <b>${smallCaps("Archive")} ${escapeHtml(product.name)}?</b>\n\n${smallCaps("This hides the product from the store and preserves existing purchases and inventory records.")}`,
      confirmDangerKeyboard(`admin:product:deleteconfirm:${product.id}`, `admin:product:view:${product.id}`),
      deps.logger,
    );
  } else if (parts[1] === "product" && parts[2] === "deleteconfirm" && parts[3]) {
    await archiveProduct(deps.database.prisma, parts[3]);
    await showProductsAdmin(ctx, deps, 0);
  } else if (data === "admin:inventory") {
    await showInventoryAdmin(ctx, deps);
  } else if (parts[1] === "inventory" && parts[2] === "category" && parts[3]) {
    await showInventoryProducts(ctx, deps, parts[3]);
  } else if (parts[1] === "stock" && (parts[2] === "product" || parts[2] === "add") && parts[3]) {
    const product = await getProduct(deps.database.prisma, parts[3]);
    await beginAdminFlow(
      ctx,
      deps,
      { kind: "inventory:add:payload", productId: product.id },
      `📥 <b>${smallCaps("Add authorized stock:")} ${escapeHtml(product.name)}</b>\n\n` +
        `${smallCaps("Send one item per line, or upload a .txt/.csv file.")}\n\n` +
        `💡 <b>${smallCaps("Supported formats (auto-parsed for buyers):")}</b>\n` +
        `• ${smallCaps("Classic:")} <code>email@domain.com:password</code>\n` +
        `• ${smallCaps("With account details:")}\n<code>email:pass | Plan: Mega Fan | Expiry: 2027-01-15 | Region: US | Profile: #2 | PIN: 1234</code>\n` +
        `• ${smallCaps("Colon-extended:")} <code>email:pass:Mega Fan:2027-01-15</code>\n` +
        `• ${smallCaps("License key / code:")} <code>KEY-XXXX-YYYY-ZZZZ</code>\n\n` +
        `${smallCaps("Maximum 500 lines per batch, 3,500 characters per item. Use /cancel to stop.")}`,
    );
  } else if (parts[1] === "stock" && parts[2] === "list" && parts[3]) {
    await showInventoryList(ctx, deps, parts[3], Number(parts[4] ?? 0));
  } else if (parts[1] === "stock" && parts[2] === "peek" && parts[3]) {
    await showInventoryItemPeek(ctx, deps, parts[3]);
  } else if (parts[1] === "stock" && parts[2] === "export" && parts[3]) {
    const { product, payloads } = await listAllAvailablePayloads(deps.database.prisma, parts[3]);
    if (!payloads.length) {
      await editOrReply(ctx, `⚠️ No available stock to export for <b>${escapeHtml(product.name)}</b>.`, new InlineKeyboard().text(smallCaps("◀ PRODUCT"), `admin:product:view:${product.id}`), deps.logger);
      return true;
    }
    const filename = `stock-${escapeFilenamePart(product.name)}-${Date.now()}.txt`;
    const stockFile = Buffer.from(payloads.join("\n") + "\n", "utf8");
    const caption = `📤 ${smallCaps("Exported")} ${payloads.length} ${smallCaps("available stock item(s) for")} ${product.emoji} ${product.name}. ${smallCaps("Keep this file private.")}`;
    try {
      await ctx.replyWithRichMessage({
        blocks: [
          richHeading("📤 Stock export ready", 1),
          richKeyValueTable([
            ["Product", `${product.emoji} ${product.name}`],
            ["Items exported", payloads.length.toLocaleString("en-US")],
            ["File", filename],
          ], "Export manifest"),
          richParagraph("This file contains private inventory payloads. Keep it secure.", true),
          {
            type: "document",
            document: { type: "document", media: new InputFile(stockFile, filename) },
            caption: { text: caption },
          },
        ],
      });
    } catch (error) {
      deps.logger.debug({ err: error }, "Rich stock export failed; using a standard document message");
      await ctx.replyWithDocument(new InputFile(stockFile, filename), { caption });
    }
  } else if (parts[1] === "stock" && parts[2] === "clear" && parts[3]) {
    const product = await getProduct(deps.database.prisma, parts[3]);
    await editOrReply(
      ctx,
      `⚠️ <b>${smallCaps("Clear all")} ${product._count.inventory} ${smallCaps("available stock item(s) for")} ${escapeHtml(product.name)}?</b>\n\n${smallCaps("Sold history is preserved; only unsold available items will be removed.")}`,
      confirmDangerKeyboard(`admin:stock:clearconfirm:${product.id}`, `admin:stock:list:${product.id}:0`),
      deps.logger,
    );
  } else if (parts[1] === "stock" && parts[2] === "clearconfirm" && parts[3]) {
    await clearAvailableInventory(deps.database.prisma, parts[3]);
    await showInventoryList(ctx, deps, parts[3], 0);
  } else if (parts[1] === "stock" && parts[2] === "announce" && parts[3]) {
    const product = await getProduct(deps.database.prisma, parts[3]);
    const text = `🔥 ${smallCaps("Restock alert")} 🔥\n\n${product.emoji} ${product.name} ${smallCaps("is now in stock!")}\n` +
      (product.planDetails ? `💎 ${product.planDetails}\n` : "") +
      `💳 ${smallCaps("Price")}: ${creditLabel(product.price)}\n` +
      `📦 ${smallCaps("Available")}: ${product._count.inventory} ${smallCaps("in stock")}\n\n` +
      `${smallCaps("Use /store to browse the catalogue.")}`;
    ctx.session.adminFlow = { kind: "broadcast:confirm", text };
    await editOrReply(
      ctx,
      `📢 <b>${smallCaps("Preview restock announcement")}</b>\n\n${escapeHtml(text)}`,
      new InlineKeyboard().text(smallCaps("📢 SEND TO USERS"), "admin:broadcast:send").text(smallCaps("❌ CANCEL"), "admin:broadcast:cancel"),
      deps.logger,
    );
  } else if (parts[1] === "stock" && parts[2] === "remove" && parts[3]) {
    const item = await deps.database.prisma.inventoryItem.findFirst({
      where: { id: parts[3], status: "AVAILABLE" },
      include: { product: { select: { name: true } } },
    });
    if (!item) throw new NotFoundError("That available stock item no longer exists.");
    await editOrReply(
      ctx,
      `⚠️ <b>${smallCaps("Remove stock item")} ${item.id.slice(0, 8)}?</b>\n\n${smallCaps("Product:")} ${escapeHtml(item.product.name)}. ${smallCaps("Its payload will not be shown here.")}`,
      confirmDangerKeyboard(`admin:stock:removeconfirm:${item.id}`, `admin:stock:list:${item.productId}:0`),
      deps.logger,
    );
  } else if (parts[1] === "stock" && parts[2] === "removeconfirm" && parts[3]) {
    const item = await deps.database.prisma.inventoryItem.findUnique({ where: { id: parts[3] }, select: { productId: true } });
    if (!item) throw new NotFoundError("That stock item no longer exists.");
    await removeInventoryItem(deps.database.prisma, parts[3]);
    await showInventoryList(ctx, deps, item.productId, 0);
  } else if (data.startsWith("admin:warranty:view:") && parts[3]) {
    await showWarrantyClaimDetail(ctx, deps, parts[3]);
  } else if (data.startsWith("admin:warranty:replace:") && parts[3]) {
    const resolved = await resolveWarrantyClaimReplace(deps.database.prisma, parts[3]);
    const replacementFallback = `🔄 <b>${smallCaps("Warranty replacement delivered")}</b>\n\n` +
      `${smallCaps("Your claim for")} ${escapeHtml(resolved.product.emoji)} <b>${escapeHtml(resolved.product.name)}</b> (<code>#${escapeHtml(resolved.purchaseId.slice(0, 8))}</code>) ${smallCaps("was approved!")}\n\n` +
      `🔐 <b>${smallCaps("Your new replacement delivery")}</b>\n` +
      renderParsedPayloadBlock(resolved.replacementPayload);
    const replacementKeyboard = new InlineKeyboard()
      .text(smallCaps("📄 Download .txt"), `order:txt:${resolved.purchaseId}`)
      .text(smallCaps("📦 View order"), `order:view:${resolved.purchaseId}`);
    await sendRichOrLegacy(ctx, Number(resolved.buyerTelegramId), {
      blocks: [
        richHeading("🔄 Warranty replacement delivered", 1),
        richParagraph([smallCaps("Your claim for "), resolved.product.emoji, " ", resolved.product.name, smallCaps(" was approved.")]),
        richKeyValueTable([
          ["Order", `#${resolved.purchaseId.slice(0, 8)}`],
          ["Status", smallCaps("Approved · replacement issued")],
        ], "Claim result"),
        richHeading("🔐 Your new replacement delivery", 2),
        ...richCredentialBlocks(resolved.replacementPayload),
        richButtonRow([
          richCallbackButton("📄 Download .txt", `order:txt:${resolved.purchaseId}`, "primary"),
          richCallbackButton("📦 View order", `order:view:${resolved.purchaseId}`, "link"),
        ]),
      ],
    }, replacementFallback, {
      fallbackKeyboard: replacementKeyboard,
      logger: deps.logger,
    }).catch((err: unknown) => deps.logger.warn({ err }, "Could not notify buyer of warranty replacement"));
    await showWarrantyClaimDetail(ctx, deps, parts[3]);
  } else if (data.startsWith("admin:warranty:refund:")) {
    throw new ValidationError("Refunds are not offered. Review the claim for a stock replacement or reject it.");
  } else if (data.startsWith("admin:warranty:reject:") && parts[3]) {
    const resolved = await resolveWarrantyClaimReject(deps.database.prisma, parts[3]);
    const rejectionFallback = `ℹ️ <b>${smallCaps("Warranty claim update")}</b>\n\n` +
      `${smallCaps("Your claim for")} ${escapeHtml(resolved.product.emoji)} <b>${escapeHtml(resolved.product.name)}</b> (<code>#${escapeHtml(resolved.purchaseId.slice(0, 8))}</code>) ${smallCaps("was declined by the store owner.")}`;
    await sendRichOrLegacy(ctx, Number(resolved.buyerTelegramId), {
      blocks: [
        richHeading("ℹ️ Warranty claim update", 1),
        richKeyValueTable([
          ["Product", `${resolved.product.emoji} ${resolved.product.name}`],
          ["Order", `#${resolved.purchaseId.slice(0, 8)}`],
          ["Status", smallCaps("Declined by the store owner")],
        ], "Claim result"),
        richParagraph("If you still need help, contact store support with your order reference.", true),
        richButtonRow([
          richCallbackButton("📦 My orders", "nav:orders"),
          richCallbackButton("🏠 Home", "nav:home", "link"),
        ]),
      ],
    }, rejectionFallback, { fallbackKeyboard: mainKeyboard(), logger: deps.logger })
      .catch((err: unknown) => deps.logger.warn({ err }, "Could not notify buyer of warranty rejection"));
    await showWarrantyClaimDetail(ctx, deps, parts[3]);
  } else if (data.startsWith("admin:warranty:")) {
    await showWarrantyClaimsAdmin(ctx, deps, Number(parts[2] ?? 0));
  } else if (data === "admin:users:0" || data.startsWith("admin:users:")) {
    await showUsersAdmin(ctx, deps, Number(parts[2] ?? 0));
  } else if (parts[1] === "user" && parts[2] && parts[2] !== "gift" && parts[2] !== "remove") {
    await showUserDetail(ctx, deps, parts[2]);
  } else if (parts[1] === "user" && (parts[2] === "gift" || parts[2] === "remove") && parts[3] && parts[4]) {
    const amount = Number(parts[4]);
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("Credit amount is invalid.");
    await changeCredits(deps.database.prisma, {
      userId: parts[3],
      amount: parts[2] === "gift" ? amount : -amount,
      type: parts[2] === "gift" ? "GIFT" : "ADMIN_ADJUSTMENT",
      description: parts[2] === "gift" ? "Owner quick gift" : "Owner quick credit removal",
    });
    await showUserDetail(ctx, deps, parts[3]);
  } else if (data.startsWith("admin:codes:")) {
    await showCodesAdmin(ctx, deps, Number(parts[2] ?? 0));
  } else if (parts[1] === "code" && parts[2] === "view" && parts[3]) {
    await showCodeDetail(ctx, deps, parts[3]);
  } else if (parts[1] === "code" && parts[2] === "toggle" && parts[3]) {
    const code = await deps.database.prisma.redeemCode.findUnique({ where: { id: parts[3] } });
    if (!code) throw new NotFoundError("That redeem code no longer exists.");
    await setRedeemCodeEnabled(deps.database.prisma, code.id, !code.enabled);
    await showCodeDetail(ctx, deps, code.id);
  } else if (data === "admin:credits") await showCreditsManagement(ctx, deps);
  else if (data === "admin:stats") await showStatistics(ctx, deps);
  else if (data.startsWith("admin:purchases:")) await showPurchasesAdmin(ctx, deps, Number(parts[2] ?? 0));
  else if (data === "admin:settings") await showSettings(ctx, deps);
  else if (data === "admin:settings:bonus") {
    await beginAdminFlow(ctx, deps, { kind: "settings:bonus" }, "🎁 Send bonus settings as: <code>CREDITS HOURS</code> (example: <code>25 24</code>). Existing claim timestamps remain unchanged.");
  } else if (data === "admin:broadcast") {
    await beginAdminFlow(ctx, deps, { kind: "broadcast:message" }, "📢 Send the plain-text broadcast now. It will be previewed before sending.");
  } else if (data === "admin:broadcast:cancel") {
    ctx.session.adminFlow = null;
    await editOrReply(ctx, smallCaps("Broadcast cancelled. No users were contacted."), adminPanelKeyboard(), deps.logger);
  } else if (data === "admin:broadcast:send") {
    const flow = ctx.session.adminFlow;
    if (!flow || flow.kind !== "broadcast:confirm") throw new Error("Broadcast preview expired. Use /broadcast again.");
    ctx.session.adminFlow = null;
    await startBroadcast(ctx, deps, flow.text);
  } else if (data === "admin:flow:cancel") {
    ctx.session.adminFlow = null;
    await editOrReply(ctx, smallCaps("Form cancelled."), adminPanelKeyboard(), deps.logger);
  } else if (data === "admin:export") {
    await sendStoreExport(ctx, deps);
    await editOrReply(ctx, smallCaps("✅ Store export sent above. Keep the file secure; it contains inventory payloads."), adminPanelKeyboard(), deps.logger);
  } else if (data === "admin:restart") {
    await requestRestart(ctx, bot, deps);
  } else if (data === "admin:reset") {
    await beginReset(ctx, deps);
  } else {
    return false;
  }
  return true;
}

async function startBroadcast(ctx: BotContext, deps: BotDependencies, text: string): Promise<void> {
  const message = ctx.callbackQuery?.message;
  const chatId = message && "message_id" in message ? message.chat.id : ctx.chat?.id;
  const messageId = message && "message_id" in message ? message.message_id : undefined;
  await editOrReply(
    ctx,
    `📢 <b>${smallCaps("Broadcast started")}</b>\n\nDelivered 0 · Failed 0`,
    adminPanelKeyboard(),
    deps.logger,
  );
  let lastProgressAt = Date.now();
  try {
    const result = await broadcastToUsers(deps.database.prisma, ctx.api, text, async (progress) => {
      if (Date.now() - lastProgressAt < 1_500 && progress.processed < progress.total) return;
      lastProgressAt = Date.now();
      if (chatId === undefined || messageId === undefined) return;
      const progressText = `📢 <b>${smallCaps("Broadcast in progress")}</b>\n\n` +
        `${smallCaps("Processed")} ${progress.processed}/${progress.total}\n✅ ${smallCaps("Delivered")} ${progress.delivered}\n⚠️ ${smallCaps("Failed")} ${progress.failed}`;
      const progressMessage = {
        blocks: [
          richHeading("📢 Broadcast in progress", 1),
          richKeyValueTable([
            ["Processed", `${progress.processed}/${progress.total}`],
            ["Delivered", progress.delivered.toLocaleString("en-US")],
            ["Failed", progress.failed.toLocaleString("en-US")],
          ], "Delivery progress"),
          richButtonRow([richCallbackButton("◀ Owner console", "admin:panel", "link")]),
        ],
      };
      await editMessageRichOrLegacy(ctx, chatId, messageId, progressMessage, progressText, {
        fallbackKeyboard: adminPanelKeyboard(),
        logger: deps.logger,
      });
    });
    const finalText = `✅ <b>${smallCaps("Broadcast complete")}</b>\n\n` +
      `${smallCaps("Processed")} ${result.processed}/${result.total}\n✅ ${smallCaps("Delivered")} ${result.delivered}\n⚠️ ${smallCaps("Failed")} ${result.failed}`;
    const finalMessage = {
      blocks: [
        richHeading("✅ Broadcast complete", 1),
        richKeyValueTable([
          ["Processed", `${result.processed}/${result.total}`],
          ["Delivered", result.delivered.toLocaleString("en-US")],
          ["Failed", result.failed.toLocaleString("en-US")],
        ], "Delivery summary"),
        richButtonRow([richCallbackButton("◀ Owner console", "admin:panel", "link")]),
      ],
    };
    if (chatId !== undefined && messageId !== undefined) {
      await editMessageRichOrLegacy(ctx, chatId, messageId, finalMessage, finalText, {
        fallbackKeyboard: adminPanelKeyboard(),
        logger: deps.logger,
      }).catch(() => undefined);
    } else {
      await replyRichOrLegacy(ctx, finalMessage, finalText, {
        fallbackKeyboard: adminPanelKeyboard(),
        logger: deps.logger,
      });
    }
    deps.logger.info({ ...result, ownerId: deps.config.ownerId.toString() }, "Broadcast completed");
  } catch (error) {
    deps.logger.error({ err: error }, "Broadcast failed");
    await editOrReply(ctx, smallCaps("⚠️ Broadcast stopped after an internal error. Check logs; already delivered messages cannot be recalled."), adminPanelKeyboard(), deps.logger);
  }
}

export function registerCallbacks(bot: Bot<BotContext>, deps: BotDependencies): void {
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (!data.startsWith("buy:confirm:") && !data.startsWith("buy:qty:")) {
      ctx.session.purchaseConfirmation = null;
    }
    if (!data.startsWith("order:claim:") && !data.startsWith("order:warranty:") && data !== "store:search:start") {
      ctx.session.userFlow = null;
    }
    const ownerAction = data.startsWith("admin:") || data.startsWith("reset:");
    if (ownerAction && !isOwner(ctx, deps.config)) {
      await ctx.answerCallbackQuery({ text: smallCaps("⛔ Owner access only."), show_alert: true }).catch(() => undefined);
      return;
    }
    if (!(await requirePrivate(ctx))) return;
    await ctx.answerCallbackQuery().catch(() => undefined);

    try {
      const handled = ownerAction
        ? await handleAdminCallback(ctx, deps, bot, data)
        : await handleUserCallback(ctx, deps, data);
      if (!handled) {
        const resetParts = data.split(":");
        if (resetParts[0] === "reset" && resetParts[1] === "continue" && resetParts[2] && resetParts[3]) {
          await continueReset(ctx, deps, resetParts[2], resetParts[3]);
        } else if (resetParts[0] === "reset" && resetParts[1] === "delete" && resetParts[2] && resetParts[3]) {
          await completeReset(ctx, deps, resetParts[2], resetParts[3]);
        } else if (resetParts[0] === "reset" && resetParts[1] === "cancel" && resetParts[2]) {
          await cancelReset(ctx, deps, resetParts[2]);
        } else {
          await editOrReply(ctx, smallCaps("That button has expired. Please open the menu again."), mainKeyboard(), deps.logger);
        }
      }
    } catch (error) {
      if (error instanceof DomainError) {
        await editOrReply(ctx, `⚠️ ${escapeHtml(smallCaps(error.message))}`, adminKeyboardFor(data), deps.logger);
        return;
      }
      deps.logger.error({ err: error, callbackType: data.split(":").slice(0, 2).join(":"), telegramId: ctx.from?.id }, "Callback handler failed");
      await editOrReply(ctx, smallCaps("⚠️ Something went wrong. Please try again or use /help."), adminKeyboardFor(data), deps.logger);
    }
  });
}
