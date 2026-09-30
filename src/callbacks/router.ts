import { randomBytes } from "node:crypto";
import { GrammyError, InlineKeyboard } from "grammy";
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
  showInventoryAdmin,
  showInventoryProducts,
  showInventoryList,
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
  showBonusStatus,
  showCategory,
  showHelp,
  showHome,
  showOrders,
  showProduct,
  showProfile,
  showStore,
} from "../bot/views.js";
import { editOrReply } from "../bot/render.js";
import { beginAdminFlow } from "../commands/admin-flow.js";
import { beginReset, cancelReset, completeReset, continueReset, requestRestart, sendStoreExport } from "../commands/admin.js";
import { broadcastToUsers } from "../services/broadcast.service.js";
import { changeCredits } from "../services/credits.service.js";
import { purchaseProduct } from "../services/purchases.service.js";
import type { PurchaseResult } from "../services/purchases.service.js";
import { listCategories, getProduct, updateCategory, updateProduct, archiveCategory, archiveProduct, reorderCategory, removeInventoryItem } from "../services/store.service.js";
import { setRedeemCodeEnabled } from "../services/codes.service.js";
import { escapeHtml, smallCaps } from "../utils/format.js";
import { DomainError, NotFoundError, PriceChangedError, ValidationError } from "../utils/errors.js";
import { productMessage, purchaseDeliveryMessage } from "../messages/iris.js";

function adminKeyboardFor(data: string) {
  return data.startsWith("admin:") || data.startsWith("reset:") ? adminPanelKeyboard() : mainKeyboard();
}

async function showPurchaseConfirmation(
  ctx: BotContext,
  deps: BotDependencies,
  productId: string,
): Promise<void> {
  const product = await getProduct(deps.database.prisma, productId);
  const user = await deps.database.prisma.user.findUnique({ where: { telegramId: BigInt(ctx.from!.id) } });
  if (!user) throw new NotFoundError("Send /start first so Iris can create your profile.");
  if (!product.enabled || product.deletedAt || !product.category.enabled || product.category.deletedAt) {
    ctx.session.purchaseConfirmation = null;
    await editOrReply(ctx, "This product is no longer available.", mainKeyboard(), deps.logger);
    return;
  }
  if (product._count.inventory <= 0) {
    ctx.session.purchaseConfirmation = null;
    await editOrReply(ctx, "⚠️ This product is out of stock right now.", new InlineKeyboard().text("◀ STORE", `store:category:${product.categoryId}:0`), deps.logger);
    return;
  }
  const text = `${productMessage({
    emoji: product.emoji,
    name: product.name,
    category: product.category.name,
    description: product.description,
    price: product.price,
    stock: product._count.inventory,
    credits: user.credits,
  })}\n\n🛒 <b>${smallCaps("Confirm this purchase?")}</b>\n${smallCaps("Your credits are charged only when stock is assigned successfully.")}`;
  const nonce = randomBytes(8).toString("hex");
  ctx.session.purchaseConfirmation = {
    productId: product.id,
    nonce,
    telegramId: ctx.from!.id,
    expectedPrice: product.price,
    expiresAt: Date.now() + 2 * 60 * 1_000,
  };
  await editOrReply(ctx, text, confirmPurchaseKeyboard(product.id, nonce, product.price), deps.logger);
}

async function handleUserCallback(ctx: BotContext, deps: BotDependencies, data: string): Promise<boolean> {
  if (data === "nav:home") await showHome(ctx, deps);
  else if (data === "nav:store") await showStore(ctx, deps);
  else if (data === "nav:profile") await showProfile(ctx, deps);
  else if (data === "nav:bonus") await showBonusStatus(ctx, deps);
  else if (data === "nav:orders") await showOrders(ctx, deps);
  else if (data === "nav:help") await showHelp(ctx, deps);
  else if (data === "bonus:claim") await claimBonus(ctx, deps, true);
  else if (data === "noop") return true;
  else if (data.startsWith("store:category:")) {
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
    await showPurchaseConfirmation(ctx, deps, productId);
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
      );
    } catch (error) {
      if (error instanceof PriceChangedError) ctx.session.purchaseConfirmation = null;
      throw error;
    }
    const keyboard = new InlineKeyboard().text("🛍 BACK TO STORE", "nav:store").text("📦 MY ORDERS", "nav:orders");
    await editOrReply(ctx, purchaseDeliveryMessage(result), keyboard, deps.logger);
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
    await beginAdminFlow(ctx, deps, { kind: "category:create:name" }, `🗂 <b>${smallCaps("New category")}</b>\n\nSend the category name (2–80 characters).`);
  } else if (parts[1] === "category" && parts[2] === "view" && parts[3]) {
    await showCategoryAdmin(ctx, deps, parts[3]);
  } else if (parts[1] === "category" && parts[2] === "toggle" && parts[3]) {
    const category = await deps.database.prisma.category.findFirst({ where: { id: parts[3], deletedAt: null } });
    if (!category) throw new NotFoundError("That category no longer exists.");
    await updateCategory(deps.database.prisma, category.id, { enabled: !category.enabled });
    await showCategoryAdmin(ctx, deps, category.id);
  } else if (parts[1] === "category" && parts[2] === "rename" && parts[3]) {
    await beginAdminFlow(ctx, deps, { kind: "category:edit:name", categoryId: parts[3] }, "✏️ Send the new category name.");
  } else if (parts[1] === "category" && parts[2] === "description" && parts[3]) {
    await beginAdminFlow(ctx, deps, { kind: "category:edit:description", categoryId: parts[3] }, "📝 Send the category description (up to 500 characters), or /skip to clear it.");
  } else if (parts[1] === "category" && parts[2] === "emoji" && parts[3]) {
    await beginAdminFlow(ctx, deps, { kind: "category:edit:emoji", categoryId: parts[3] }, "🎨 Send the new category icon or emoji.");
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
      `⚠️ <b>Archive ${escapeHtml(category.name)}?</b>\n\nThis hides the category and disables/archives its ${category._count.products} product(s). Existing purchase history remains.`,
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
    await beginAdminFlow(ctx, deps, { kind: "product:create:name", categoryId: parts[3] }, `📦 <b>${smallCaps("Add product")}</b>\n\nSend a product name (2–120 characters).`);
  } else if (data.startsWith("admin:products:")) {
    await showProductsAdmin(ctx, deps, Number(parts[2] ?? 0));
  } else if (parts[1] === "product" && parts[2] === "view" && parts[3]) {
    await showProductAdmin(ctx, deps, parts[3]);
  } else if (parts[1] === "product" && parts[2] === "edit" && parts[3] && parts[4]) {
    const kind = parts[3];
    const productId = parts[4];
    const flow = kind === "name" ? { kind: "product:edit:name" as const, productId }
      : kind === "description" ? { kind: "product:edit:description" as const, productId }
      : kind === "price" ? { kind: "product:edit:price" as const, productId }
      : kind === "emoji" ? { kind: "product:edit:emoji" as const, productId }
      : null;
    if (!flow) throw new Error("Unknown product field.");
    const prompts = {
      name: "✏️ Send the new product name.",
      description: "📝 Send the new description, or /skip to clear it.",
      price: "💳 Send the new whole-credit price (0–1,000,000,000).",
      emoji: "🎨 Send the new product icon, or /skip to use ✦.",
    };
    await beginAdminFlow(ctx, deps, flow, prompts[kind as keyof typeof prompts]);
  } else if (parts[1] === "product" && parts[2] === "toggle" && parts[3]) {
    const product = await getProduct(deps.database.prisma, parts[3]);
    await updateProduct(deps.database.prisma, product.id, { enabled: !product.enabled });
    await showProductAdmin(ctx, deps, product.id);
  } else if (parts[1] === "product" && parts[2] === "category" && parts[3]) {
    const product = await getProduct(deps.database.prisma, parts[3]);
    const categories = await listCategories(deps.database.prisma);
    const keyboard = new InlineKeyboard();
    for (const category of categories) keyboard.text(`${category.emoji} ${category.name}`.slice(0, 55), `admin:product:move:${product.id}:${category.id}`).row();
    keyboard.text("◀ PRODUCT", `admin:product:view:${product.id}`);
    await editOrReply(ctx, `🗂 <b>Move ${escapeHtml(product.name)}</b>\n\nChoose a category.`, keyboard, deps.logger);
  } else if (parts[1] === "product" && parts[2] === "move" && parts[3] && parts[4]) {
    await updateProduct(deps.database.prisma, parts[3], { categoryId: parts[4] });
    await showProductAdmin(ctx, deps, parts[3]);
  } else if (parts[1] === "product" && parts[2] === "delete" && parts[3]) {
    const product = await getProduct(deps.database.prisma, parts[3]);
    await editOrReply(
      ctx,
      `⚠️ <b>Archive ${escapeHtml(product.name)}?</b>\n\nThis hides the product from the store and preserves existing purchases and inventory records.`,
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
  } else if (parts[1] === "stock" && parts[2] === "product" && parts[3]) {
    const product = await getProduct(deps.database.prisma, parts[3]);
    await beginAdminFlow(ctx, deps, { kind: "inventory:add:payload", productId: product.id },
      `📥 <b>Add authorized stock: ${escapeHtml(product.name)}</b>\n\nSend one inventory code/license/value per line, or upload a .txt/.csv file with one item per line.\n\nMaximum 500 lines per batch, 3,500 characters per item. Use /cancel to stop.`);
  } else if (parts[1] === "stock" && parts[2] === "add" && parts[3]) {
    const product = await getProduct(deps.database.prisma, parts[3]);
    await beginAdminFlow(ctx, deps, { kind: "inventory:add:payload", productId: product.id },
      `📥 <b>Add authorized stock: ${escapeHtml(product.name)}</b>\n\nSend one inventory code/license/value per line, or upload a .txt/.csv file with one item per line.\n\nMaximum 500 lines per batch, 3,500 characters per item. Use /cancel to stop.`);
  } else if (parts[1] === "stock" && parts[2] === "list" && parts[3]) {
    await showInventoryList(ctx, deps, parts[3], Number(parts[4] ?? 0));
  } else if (parts[1] === "stock" && parts[2] === "remove" && parts[3]) {
    const item = await deps.database.prisma.inventoryItem.findFirst({
      where: { id: parts[3], status: "AVAILABLE" },
      include: { product: { select: { name: true } } },
    });
    if (!item) throw new NotFoundError("That available stock item no longer exists.");
    await editOrReply(
      ctx,
      `⚠️ <b>Remove stock item ${item.id.slice(0, 8)}?</b>\n\nProduct: ${escapeHtml(item.product.name)}. Its payload will not be shown here.`,
      confirmDangerKeyboard(`admin:stock:removeconfirm:${item.id}`, `admin:stock:list:${item.productId}:0`),
      deps.logger,
    );
  } else if (parts[1] === "stock" && parts[2] === "removeconfirm" && parts[3]) {
    const item = await deps.database.prisma.inventoryItem.findUnique({ where: { id: parts[3] }, select: { productId: true } });
    if (!item) throw new NotFoundError("That stock item no longer exists.");
    await removeInventoryItem(deps.database.prisma, parts[3]);
    await showInventoryList(ctx, deps, item.productId, 0);
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
    await editOrReply(ctx, "Broadcast cancelled. No users were contacted.", adminPanelKeyboard(), deps.logger);
  } else if (data === "admin:broadcast:send") {
    const flow = ctx.session.adminFlow;
    if (!flow || flow.kind !== "broadcast:confirm") throw new Error("Broadcast preview expired. Use /broadcast again.");
    ctx.session.adminFlow = null;
    await startBroadcast(ctx, deps, flow.text);
  } else if (data === "admin:flow:cancel") {
    ctx.session.adminFlow = null;
    await editOrReply(ctx, "Form cancelled.", adminPanelKeyboard(), deps.logger);
  } else if (data === "admin:export") {
    await sendStoreExport(ctx, deps);
    await editOrReply(ctx, "✅ Store export sent above. Keep the file secure; it contains inventory payloads.", adminPanelKeyboard(), deps.logger);
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
        `Processed ${progress.processed}/${progress.total}\n✅ Delivered ${progress.delivered}\n⚠️ Failed ${progress.failed}`;
      try {
        await ctx.api.editMessageText(chatId, messageId, progressText, { parse_mode: "HTML", reply_markup: adminPanelKeyboard() });
      } catch (error) {
        if (!(error instanceof GrammyError) || !/message is not modified/i.test(error.description)) {
          deps.logger.debug({ err: error }, "Broadcast progress message could not be updated");
        }
      }
    });
    const finalText = `✅ <b>${smallCaps("Broadcast complete")}</b>\n\nProcessed ${result.processed}/${result.total}\n✅ Delivered ${result.delivered}\n⚠️ Failed ${result.failed}`;
    if (chatId !== undefined && messageId !== undefined) {
      await ctx.api.editMessageText(chatId, messageId, finalText, { parse_mode: "HTML", reply_markup: adminPanelKeyboard() }).catch(() => undefined);
    } else {
      await ctx.reply(finalText, { parse_mode: "HTML", reply_markup: adminPanelKeyboard() });
    }
    deps.logger.info({ ...result, ownerId: deps.config.ownerId.toString() }, "Broadcast completed");
  } catch (error) {
    deps.logger.error({ err: error }, "Broadcast failed");
    await editOrReply(ctx, "⚠️ Broadcast stopped after an internal error. Check logs; already delivered messages cannot be recalled.", adminPanelKeyboard(), deps.logger);
  }
}

export function registerCallbacks(bot: Bot<BotContext>, deps: BotDependencies): void {
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (!data.startsWith("buy:confirm:")) ctx.session.purchaseConfirmation = null;
    const ownerAction = data.startsWith("admin:") || data.startsWith("reset:");
    if (ownerAction && !isOwner(ctx, deps.config)) {
      await ctx.answerCallbackQuery({ text: "⛔ Owner access only.", show_alert: true }).catch(() => undefined);
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
          await editOrReply(ctx, "That button has expired. Please open the menu again.", mainKeyboard(), deps.logger);
        }
      }
    } catch (error) {
      if (error instanceof DomainError) {
        await editOrReply(ctx, `⚠️ ${escapeHtml(error.message)}`, adminKeyboardFor(data), deps.logger);
        return;
      }
      deps.logger.error({ err: error, callbackType: data.split(":").slice(0, 2).join(":"), telegramId: ctx.from?.id }, "Callback handler failed");
      await editOrReply(ctx, "⚠️ Something went wrong. Please try again or use /help.", adminKeyboardFor(data), deps.logger);
    }
  });
}
