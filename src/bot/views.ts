import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { InlineKeyboard, InputFile } from "grammy";
import type { InputMediaPhoto } from "grammy/types";
import {
  getUserPurchaseDetail,
  listUserPurchases,
} from "../services/purchases.service.js";
import { getBonusSettings } from "../services/settings.service.js";
import { listUserCreditTransactions } from "../services/credits.service.js";
import {
  getProduct,
  isSubscribedToStock,
  listCategoryProducts,
  listEnabledCategories,
  listFeaturedProducts,
  searchProducts,
} from "../services/store.service.js";
import { countUserPurchases, findUserByTelegramId, saveProfilePhoto } from "../services/users.service.js";
import {
  helpMessage,
  productMessage,
  profileMessage,
  renderParsedPayloadBlock,
  richOrderDetailMessage,
  richOrderHistoryMessage,
  richProductMessage,
  welcomeMessage,
} from "../messages/iris.js";
import {
  categoriesKeyboard,
  mainKeyboard,
  profileKeyboard,
  storeCategoryProductsKeyboard,
} from "../keyboards/inline.js";
import { editOrReply, editOrReplyRich, isUnchangedEdit } from "./render.js";
import type { BotContext } from "../types/context.js";
import type { BotDependencies } from "./dependencies.js";
import {
  creditLabel,
  escapeFilenamePart,
  escapeHtml,
  formatDate,
  formatDuration,
  smallCaps,
  truncate,
} from "../utils/format.js";
import { buildOrderReceiptText } from "../utils/credential-parser.js";
import { BonusUnavailableError, DomainError } from "../utils/errors.js";
import { claimDailyBonus, getBonusStatus } from "../services/bonus.service.js";

const START_VIDEO_URL = "https://imglink.cc/cdn/jw1NZXEQQS.mp4";
const DEFAULT_AVATAR_PATH = fileURLToPath(new URL("../../assets/iris-avatar.png", import.meta.url));
const PAGE_SIZE = 8;

export async function showHome(ctx: BotContext, deps: BotDependencies): Promise<void> {
  const user = ctx.from;
  await editOrReply(
    ctx,
    welcomeMessage(user?.first_name),
    mainKeyboard(),
    deps.logger,
  );
}

export async function sendWelcomeVideo(ctx: BotContext, deps: BotDependencies): Promise<void> {
  const text = welcomeMessage(ctx.from?.first_name);
  try {
    await ctx.replyWithVideo(START_VIDEO_URL, {
      caption: text,
      parse_mode: "HTML",
      reply_markup: mainKeyboard(),
      supports_streaming: true,
    });
  } catch (error) {
    deps.logger.warn({ err: error }, "Welcome video could not be delivered; using a text welcome");
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: mainKeyboard() });
  }
}

export async function showStore(ctx: BotContext, deps: BotDependencies): Promise<void> {
  const [categories, featured] = await Promise.all([
    listEnabledCategories(deps.database.prisma),
    listFeaturedProducts(deps.database.prisma, 0, 1),
  ]);
  if (!categories.length) {
    await editOrReply(
      ctx,
      `🛍 <b>${smallCaps("Iris store")}</b>\n\n${smallCaps("The shelves are being arranged. Please check back soon.")}`,
      mainKeyboard(),
      deps.logger,
    );
    return;
  }
  await editOrReply(
    ctx,
    `🛍 <b>${smallCaps("Iris store")}</b>\n\n${smallCaps("Choose a category, browse featured items, or search the catalog.")}`,
    categoriesKeyboard(categories, featured.total),
    deps.logger,
  );
}

export async function showFeaturedStore(
  ctx: BotContext,
  deps: BotDependencies,
  page = 0,
): Promise<void> {
  const result = await listFeaturedProducts(deps.database.prisma, page, PAGE_SIZE);
  const keyboard = new InlineKeyboard();
  for (const product of result.products) {
    const status = product._count.inventory > 0 ? "" : " · OUT OF STOCK";
    keyboard.text(
      `🔥 ${product.emoji} ${product.name} · ${product.price} credits${status}`.slice(0, 58),
      `store:product:${product.id}`,
    ).row();
  }
  if (page > 0) keyboard.text("◀", `store:featured:${page - 1}`);
  keyboard.text(`${page + 1}/${result.pages}`, "noop");
  if (page + 1 < result.pages) keyboard.text("▶", `store:featured:${page + 1}`);
  keyboard.row().text("◀ STORE", "nav:store").text("🏠 HOME", "nav:home");

  const text = result.products.length
    ? `🔥 <b>${smallCaps("Featured products")}</b>\n\n${smallCaps("Hand-picked popular items in the store.")}`
    : `🔥 <b>${smallCaps("Featured products")}</b>\n\n${smallCaps("No featured items right now.")}`;
  await editOrReply(ctx, text, keyboard, deps.logger);
}

export async function showStoreSearchResults(
  ctx: BotContext,
  deps: BotDependencies,
  query: string,
): Promise<void> {
  const result = await searchProducts(deps.database.prisma, query, 0, PAGE_SIZE);
  const keyboard = new InlineKeyboard();
  for (const product of result.products) {
    const status = product._count.inventory > 0 ? "" : " · OUT OF STOCK";
    const badge = product.featured ? "🔥 " : "";
    keyboard.text(
      `${badge}${product.emoji} ${product.name} · ${product.price} credits${status}`.slice(0, 58),
      `store:product:${product.id}`,
    ).row();
  }
  keyboard.text("🔍 NEW SEARCH", "store:search:start").text("◀ STORE", "nav:store").row().text("🏠 HOME", "nav:home");

  const text = result.products.length
    ? `🔍 <b>${smallCaps("Search results for")} "${escapeHtml(query)}"</b>\n\nFound ${result.total} matching product(s).`
    : `🔍 <b>${smallCaps("No results for")} "${escapeHtml(query)}"</b>\n\n${smallCaps("Try another keyword or browse the store categories.")}`;
  await editOrReply(ctx, text, keyboard, deps.logger);
}

export async function showCategory(
  ctx: BotContext,
  deps: BotDependencies,
  categoryId: string,
  page = 0,
): Promise<void> {
  const category = await deps.database.prisma.category.findFirst({
    where: { id: categoryId, enabled: true, deletedAt: null },
  });
  if (!category) {
    await editOrReply(ctx, smallCaps("That category is no longer available."), mainKeyboard(), deps.logger);
    return;
  }
  const result = await listCategoryProducts(deps.database.prisma, categoryId, page, PAGE_SIZE);
  const text = result.products.length
    ? `${escapeHtml(category.emoji)} <b>${escapeHtml(smallCaps(category.name))}</b>\n\n${escapeHtml(category.description || smallCaps("Available digital goods"))}\n\n${smallCaps("Select an item to see details.")}`
    : `${escapeHtml(category.emoji)} <b>${escapeHtml(smallCaps(category.name))}</b>\n\n${smallCaps("No available products in this category yet.")}`;
  await editOrReply(
    ctx,
    text,
    storeCategoryProductsKeyboard(result.products, categoryId, page, result.pages),
    deps.logger,
  );
}

export async function showProduct(ctx: BotContext, deps: BotDependencies, productId: string): Promise<void> {
  const product = await getProduct(deps.database.prisma, productId);
  const currentUser = await findUserByTelegramId(deps.database.prisma, ctx.from!.id);
  const canBuy = product.enabled && product.deletedAt === null && product.category.enabled &&
    product.category.deletedAt === null && product._count.inventory > 0;
  const keyboard = new InlineKeyboard();
  if (canBuy) {
    keyboard.text("🛒 BUY", `buy:start:${product.id}`).row();
  } else {
    const subscribed = await isSubscribedToStock(deps.database.prisma, currentUser.id, product.id);
    keyboard.text("⚠️ OUT OF STOCK", "noop").row();
    keyboard.text(
      subscribed ? "🔕 UNSUBSCRIBE RESTOCK ALERT" : "🔔 NOTIFY WHEN RESTOCKED",
      `store:notify:${product.id}`,
    ).row();
  }
  if (product.mediaFileId) {
    keyboard.text("🖼 VIEW BANNER", `store:banner:${product.id}`).row();
  }
  keyboard.text("◀ BACK", `store:category:${product.categoryId}:0`).text("🏠 HOME", "nav:home");
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
    credits: currentUser.credits,
  };
  await editOrReplyRich(ctx, richProductMessage(card), productMessage(card), keyboard, deps.logger);
}

export async function showProfile(ctx: BotContext, deps: BotDependencies): Promise<void> {
  const user = await findUserByTelegramId(deps.database.prisma, ctx.from!.id);
  const settings = await getBonusSettings(deps.database.prisma, {
    credits: deps.config.bonusCredits,
    periodHours: deps.config.bonusPeriodHours,
  });
  const [purchaseCount, bonusStatus] = await Promise.all([
    countUserPurchases(deps.database.prisma, user.id),
    getBonusStatus(deps.database.prisma, user.id, settings.periodHours),
  ]);

  let photoFileId = user.profilePhotoFileId;
  try {
    const photos = await ctx.api.getUserProfilePhotos(ctx.from!.id, { limit: 1 });
    const latestPhoto = photos.photos[0]?.at(-1)?.file_id ?? null;
    if (latestPhoto !== photoFileId) {
      await saveProfilePhoto(deps.database.prisma, ctx.from!.id, latestPhoto);
      photoFileId = latestPhoto;
    }
  } catch (error) {
    deps.logger.debug({ err: error, telegramId: ctx.from!.id }, "Could not retrieve Telegram profile photo");
  }

  const displayName = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" ") || "Iris user";
  const caption = profileMessage({
    displayName,
    username: ctx.from?.username ?? null,
    telegramId: BigInt(ctx.from!.id),
    credits: user.credits,
    purchaseCount,
    createdAt: user.createdAt,
    lastActiveAt: user.lastActiveAt,
    nextBonusAt: bonusStatus.nextAvailableAt,
    bonusAvailable: bonusStatus.available,
  });

  let media: InputMediaPhoto;
  if (photoFileId) {
    media = { type: "photo", media: photoFileId, caption, parse_mode: "HTML" };
  } else {
    const avatar = await readFile(DEFAULT_AVATAR_PATH);
    media = { type: "photo", media: new InputFile(avatar, "iris-avatar.png"), caption, parse_mode: "HTML" };
  }

  const source = ctx.callbackQuery?.message;
  if (source && "message_id" in source && source.date !== 0) {
    try {
      await ctx.api.editMessageMedia(source.chat.id, source.message_id, media, {
        reply_markup: profileKeyboard(),
      });
      return;
    } catch (error) {
      if (isUnchangedEdit(error)) return;
      deps.logger.debug({ err: error }, "Profile photo cannot replace the current menu message");
      if (!("photo" in source || "video" in source || "animation" in source || "document" in source)) {
        try {
          await ctx.api.editMessageText(
            source.chat.id,
            source.message_id,
            smallCaps("Your profile card is below."),
          );
        } catch (editError) {
          deps.logger.debug({ err: editError }, "Unable to clear the previous profile menu");
        }
      }
    }
  }

  try {
    const photo = photoFileId
      ? photoFileId
      : new InputFile(await readFile(DEFAULT_AVATAR_PATH), "iris-avatar.png");
    await ctx.replyWithPhoto(photo, { caption, parse_mode: "HTML", reply_markup: profileKeyboard() });
  } catch (error) {
    deps.logger.warn({ err: error }, "Could not send profile avatar; falling back to a text profile");
    await editOrReply(ctx, caption, profileKeyboard(), deps.logger);
  }
}

const CREDIT_TYPE_ICONS: Record<string, string> = {
  BONUS: "🎁",
  GIFT: "🎉",
  GIFT_ALL: "🎊",
  REDEEM: "🎟️",
  PURCHASE: "🛍️",
  REFUND: "↩️",
  ADMIN_ADJUSTMENT: "⚙️",
};

export async function showWallet(ctx: BotContext, deps: BotDependencies, requestedPage = 0): Promise<void> {
  const user = await findUserByTelegramId(deps.database.prisma, ctx.from!.id);
  const history = await listUserCreditTransactions(deps.database.prisma, user.id, requestedPage, PAGE_SIZE);
  const balance = `💰 <b>${smallCaps("Available balance")}:</b> ${creditLabel(user.credits)}`;
  const keyboard = new InlineKeyboard();

  if (history.total === 0) {
    keyboard
      .text("🎁 CLAIM BONUS", "nav:bonus")
      .text("🛍 STORE", "nav:store")
      .row()
      .text("🏠 HOME", "nav:home");
    await editOrReply(
      ctx,
      `💳 <b>${smallCaps("Wallet activity")}</b>\n\n${balance}\n\n${smallCaps("No credit activity yet. Claim a bonus or explore the store to get started.")}`,
      keyboard,
      deps.logger,
    );
    return;
  }

  const entries = history.transactions.map((transaction) => {
    const amount = transaction.amount > 0
      ? `+${creditLabel(transaction.amount)}`
      : transaction.amount < 0
        ? `−${creditLabel(Math.abs(transaction.amount))}`
        : creditLabel(0);
    const icon = CREDIT_TYPE_ICONS[transaction.type] ?? "✦";
    const description = escapeHtml(truncate(transaction.description, 80));
    return `${icon} <b>${description}</b>\n` +
      `${amount} · ${smallCaps("Balance")}: ${creditLabel(transaction.balanceAfter)}\n` +
      `<i>${escapeHtml(formatDate(transaction.createdAt))}</i>`;
  });

  if (history.pages > 1) {
    if (history.page > 0) keyboard.text("◀", `wallet:page:${history.page - 1}`);
    keyboard.text(`${history.page + 1}/${history.pages}`, "noop");
    if (history.page + 1 < history.pages) keyboard.text("▶", `wallet:page:${history.page + 1}`);
    keyboard.row();
  }
  keyboard
    .text("🎁 BONUS", "nav:bonus")
    .text("🛍 STORE", "nav:store")
    .row()
    .text("📦 ORDERS", "nav:orders")
    .text("🏠 HOME", "nav:home");

  await editOrReply(
    ctx,
    `💳 <b>${smallCaps("Wallet activity")}</b>\n\n${balance}\n\n${smallCaps("Recent credit activity · newest first")}\n\n${entries.join("\n\n")}`,
    keyboard,
    deps.logger,
  );
}

export async function showBonusStatus(ctx: BotContext, deps: BotDependencies): Promise<void> {
  const user = await findUserByTelegramId(deps.database.prisma, ctx.from!.id);
  const settings = await getBonusSettings(deps.database.prisma, {
    credits: deps.config.bonusCredits,
    periodHours: deps.config.bonusPeriodHours,
  });
  const status = await getBonusStatus(deps.database.prisma, user.id, settings.periodHours);
  const keyboard = status.available
    ? new InlineKeyboard().text("🎁 CLAIM BONUS", "bonus:claim").row().text("◀ HOME", "nav:home")
    : new InlineKeyboard().text("◀ HOME", "nav:home");
  const body = status.available
    ? `🎁 <b>${smallCaps("Daily bonus ready")}</b>\n\n${smallCaps("Claim your credits and keep exploring Iris.")}\n\n💳 ${creditLabel(settings.credits)}`
    : `🎁 <b>${smallCaps("Bonus claimed")}</b>\n\n${smallCaps("Next bonus in")} ${formatDuration(status.remainingMs)}\n${smallCaps("Available at")} ${escapeHtml(formatDate(status.nextAvailableAt))}`;
  await editOrReply(ctx, body, keyboard, deps.logger);
}

export async function claimBonus(ctx: BotContext, deps: BotDependencies, edit = false): Promise<void> {
  const user = await findUserByTelegramId(deps.database.prisma, ctx.from!.id);
  const settings = await getBonusSettings(deps.database.prisma, {
    credits: deps.config.bonusCredits,
    periodHours: deps.config.bonusPeriodHours,
  });
  try {
    const result = await claimDailyBonus(deps.database.prisma, user.id, settings.credits, settings.periodHours);
    const text = `🎉 <b>${smallCaps("Bonus collected")}</b>\n\n` +
      `✦ +${creditLabel(result.creditsReceived)}\n` +
      `💰 ${smallCaps("Balance")}: ${creditLabel(result.balance)}\n` +
      `⏳ ${smallCaps("Next bonus")}: ${escapeHtml(formatDate(result.nextAvailableAt))}`;
    if (edit || ctx.callbackQuery) await editOrReply(ctx, text, mainKeyboard(), deps.logger);
    else await ctx.reply(text, { parse_mode: "HTML", reply_markup: mainKeyboard() });
  } catch (error) {
    if (!(error instanceof BonusUnavailableError || error instanceof DomainError)) throw error;
    const text = error instanceof BonusUnavailableError
      ? `🎁 ${smallCaps("Your bonus is already claimed.")}\n\n${smallCaps("Next available")} ${escapeHtml(formatDate(error.nextAvailableAt))}`
      : `⚠️ ${escapeHtml(error.message)}`;
    if (edit || ctx.callbackQuery) await editOrReply(ctx, text, mainKeyboard(), deps.logger);
    else await ctx.reply(text, { parse_mode: "HTML", reply_markup: mainKeyboard() });
  }
}

export async function showOrders(ctx: BotContext, deps: BotDependencies, page = 0): Promise<void> {
  const user = await findUserByTelegramId(deps.database.prisma, ctx.from!.id);
  const [purchases, total] = await Promise.all([
    listUserPurchases(deps.database.prisma, user.id, Math.max(0, page) * PAGE_SIZE, PAGE_SIZE),
    deps.database.prisma.purchase.count({ where: { buyerId: user.id } }),
  ]);
  if (!purchases.length) {
    await editOrReply(
      ctx,
      `📦 <b>${smallCaps("No purchases yet")}</b>\n\n${smallCaps("Your next favorite find is waiting in the store.")}`,
      mainKeyboard(),
      deps.logger,
    );
    return;
  }

  const keyboard = new InlineKeyboard();
  for (const purchase of purchases) {
    const claimBadge = purchase.warrantyClaim
      ? purchase.warrantyClaim.status === "PENDING" ? " · ⏳"
        : purchase.warrantyClaim.status === "REPLACED" ? " · 🔄"
        : purchase.warrantyClaim.status === "REFUNDED" ? " · 💳"
        : ""
      : "";
    keyboard.text(
      `${purchase.product.emoji} ${purchase.product.name} · #${purchase.id.slice(0, 6)}${claimBadge}`.slice(0, 58),
      `order:view:${purchase.id}`,
    ).row();
  }
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (pages > 1) {
    if (page > 0) keyboard.text("◀", `orders:page:${page - 1}`);
    keyboard.text(`${page + 1}/${pages}`, "noop");
    if (page + 1 < pages) keyboard.text("▶", `orders:page:${page + 1}`);
    keyboard.row();
  }
  keyboard.text("🛍 STORE", "nav:store").text("🏠 HOME", "nav:home");

  const lines = purchases.map((purchase) =>
    `• ${escapeHtml(purchase.product.emoji)} <b>${escapeHtml(purchase.product.name)}</b> — ${creditLabel(purchase.amountPaid)}\n  <code>#${escapeHtml(purchase.id.slice(0, 8))}</code> · ${escapeHtml(formatDate(purchase.createdAt))}`,
  );
  await editOrReplyRich(
    ctx,
    richOrderHistoryMessage(purchases, total),
    `📦 <b>${smallCaps("Your Order Vault")}</b> · ${total}\n\n${smallCaps("Tap any order below to view its email, password, delivery details, or download a .txt receipt. Eligible delivery issues may be reviewed for replacement; refunds are not offered.")}\n\n${lines.join("\n\n")}`,
    keyboard,
    deps.logger,
  );
}

export async function showOrderDetail(
  ctx: BotContext,
  deps: BotDependencies,
  purchaseId: string,
): Promise<void> {
  const user = await findUserByTelegramId(deps.database.prisma, ctx.from!.id);
  const purchase = await getUserPurchaseDetail(deps.database.prisma, user.id, purchaseId);

  const warrantyExpiresAt = purchase.createdAt.getTime() + purchase.product.warrantyHours * 3_600_000;
  const warrantyRemainingMs = warrantyExpiresAt - Date.now();
  const warrantyActive = purchase.product.warrantyHours > 0 && warrantyRemainingMs > 0;

  let warrantyStatusText = "None";
  let warrantyStatusLine = `🛡 <b>${smallCaps("Replacement coverage")}:</b> None`;
  if (purchase.warrantyClaim) {
    const statusMap: Record<string, string> = {
      PENDING: "⏳ Issue pending owner review",
      REPLACED: "✅ Replaced with fresh stock",
      REFUNDED: "Historical credit refund",
      REJECTED: "❌ Issue declined",
    };
    warrantyStatusText = statusMap[purchase.warrantyClaim.status] ?? purchase.warrantyClaim.status;
    if (purchase.warrantyClaim.resolutionNote) {
      warrantyStatusText += ` (${purchase.warrantyClaim.resolutionNote})`;
    }
    warrantyStatusLine = `🛡 <b>${smallCaps("Replacement coverage")}:</b> ${escapeHtml(warrantyStatusText)}`;
  } else if (purchase.product.warrantyHours > 0) {
    warrantyStatusText = warrantyActive
      ? `Active (${formatDuration(warrantyRemainingMs)} remaining)`
      : "Expired";
    warrantyStatusLine = `🛡 <b>${smallCaps("Replacement coverage")}:</b> ${escapeHtml(warrantyStatusText)}`;
  }

  const sections: string[] = [
    `🧾 <b>${smallCaps("Order Receipt")}</b> · <code>#${escapeHtml(purchase.id.slice(0, 8))}</code>\n\n` +
      `📦 <b>${smallCaps("Product")}:</b> ${escapeHtml(purchase.product.emoji)} ${escapeHtml(purchase.product.name)}\n` +
      `🗂 <b>${smallCaps("Category")}:</b> ${escapeHtml(purchase.product.category.name)}\n` +
      `💳 <b>${smallCaps("Paid")}:</b> ${creditLabel(purchase.amountPaid)}\n` +
      `🗓 <b>${smallCaps("Date")}:</b> ${escapeHtml(formatDate(purchase.createdAt))}\n` +
      warrantyStatusLine,
  ];

  if (purchase.product.planDetails.trim()) {
    sections.push(`💎 <b>${smallCaps("Account / Plan details")}</b>\n${escapeHtml(purchase.product.planDetails.trim())}`);
  }

  sections.push(
    `🔐 <b>${smallCaps("Delivered credentials & details")}</b>\n` +
      renderParsedPayloadBlock(purchase.inventoryItem.payload),
  );

  if (purchase.product.deliveryInstructions.trim()) {
    sections.push(
      `📜 <b>${smallCaps("Login guide & rules")}</b>\n${escapeHtml(purchase.product.deliveryInstructions.trim())}`,
    );
  }
  sections.push(`<i>${smallCaps("Keep credentials private. All sales are final; refunds are not offered.")}</i>`);

  const keyboard = new InlineKeyboard()
    .text("📄 DOWNLOAD .TXT", `order:txt:${purchase.id}`);
  if (warrantyActive && !purchase.warrantyClaim) {
    keyboard.text("🛠 REPORT ISSUE", `order:warranty:${purchase.id}`);
  }
  keyboard.row().text("◀ MY ORDERS", "nav:orders").text("🏠 HOME", "nav:home");

  await editOrReplyRich(
    ctx,
    richOrderDetailMessage({
      purchaseId: purchase.id,
      productName: purchase.product.name,
      productEmoji: purchase.product.emoji,
      categoryName: purchase.product.category.name,
      amountPaid: purchase.amountPaid,
      createdAt: purchase.createdAt,
      warrantyStatus: warrantyStatusText,
      payload: purchase.inventoryItem.payload,
      planDetails: purchase.product.planDetails,
      deliveryInstructions: purchase.product.deliveryInstructions,
    }),
    sections.join("\n\n"),
    keyboard,
    deps.logger,
  );
}

export async function sendOrderReceiptFile(
  ctx: BotContext,
  deps: BotDependencies,
  purchaseId: string,
): Promise<void> {
  const user = await findUserByTelegramId(deps.database.prisma, ctx.from!.id);
  const purchase = await getUserPurchaseDetail(deps.database.prisma, user.id, purchaseId);
  const receiptText = buildOrderReceiptText({
    purchaseId: purchase.id,
    productName: purchase.product.name,
    categoryName: purchase.product.category.name,
    paid: purchase.amountPaid,
    createdAt: purchase.createdAt,
    payload: purchase.inventoryItem.payload,
    planDetails: purchase.product.planDetails,
    deliveryInstructions: purchase.product.deliveryInstructions,
    warrantyHours: purchase.product.warrantyHours,
  });
  const filename = `iris-receipt-${escapeFilenamePart(purchase.product.name)}-${purchase.id.slice(0, 8)}.txt`;
  await ctx.replyWithDocument(new InputFile(Buffer.from(receiptText, "utf8"), filename), {
    caption: `📄 <b>${smallCaps("Order receipt")}</b> · <code>#${escapeHtml(purchase.id.slice(0, 8))}</code>`,
    parse_mode: "HTML",
  });
}

export async function showWarrantyPrompt(
  ctx: BotContext,
  deps: BotDependencies,
  purchaseId: string,
): Promise<void> {
  const user = await findUserByTelegramId(deps.database.prisma, ctx.from!.id);
  const purchase = await getUserPurchaseDetail(deps.database.prisma, user.id, purchaseId);
  ctx.session.userFlow = { kind: "warranty:reason", purchaseId: purchase.id };

  const keyboard = new InlineKeyboard()
    .text("❌ Invalid Email / Password", `order:claim:${purchase.id}:invalid_creds`)
    .row()
    .text("🔒 Account Locked / 2FA", `order:claim:${purchase.id}:locked`)
    .row()
    .text("📉 Plan Expired / Free Tier", `order:claim:${purchase.id}:expired`)
    .row()
    .text("◀ BACK TO ORDER", `order:view:${purchase.id}`);

  const text = `🛠 <b>${smallCaps("Report a delivery issue")}</b>\n\n` +
    `📦 <b>${escapeHtml(purchase.product.emoji)} ${escapeHtml(purchase.product.name)}</b> (<code>#${escapeHtml(purchase.id.slice(0, 8))}</code>)\n\n` +
    `${smallCaps("Select a reason below, or describe what went wrong. Approved issues may receive a stock replacement only; refunds are not offered.")}`;
  await editOrReply(ctx, text, keyboard, deps.logger);
}

export async function showHelp(ctx: BotContext, deps: BotDependencies): Promise<void> {
  await editOrReply(ctx, helpMessage(), mainKeyboard(), deps.logger);
}

export function parsePositiveInteger(raw: string, label: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive whole number.`);
  return value;
}
