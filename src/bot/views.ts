import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { InlineKeyboard, InputFile } from "grammy";
import type { InputRichBlock, InputRichMessage, RichText } from "grammy/types";
import {
  getUserPurchaseDetail,
  listUserPurchases,
} from "../services/purchases.service.js";
import { getBonusSettings, getReferralSettings } from "../services/settings.service.js";
import { listUserCreditTransactions } from "../services/credits.service.js";
import {
  buildReferralLink,
  buildReferralShareUrl,
  getUserReferralSummary,
  listUserReferrals,
} from "../services/referrals.service.js";
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
  richHelpMessage,
  richHomeMessage,
  richOrderHistoryMessage,
  richProductMessage,
  welcomeMessage,
} from "../messages/iris.js";
import {
  richButtonRow,
  richCallbackButton,
  richDataTable,
  richFooter,
  richHeading,
  richKeyValueTable,
  richParagraph,
} from "../messages/rich-ui.js";
import {
  categoriesKeyboard,
  mainKeyboard,
  profileKeyboard,
  storeCategoryProductsKeyboard,
} from "../keyboards/inline.js";
import { editOrReply, editOrReplyRich } from "./render.js";
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

const START_VIDEO_URL = "https://imglink.cc/cdn/rCEZkzLQra.mp4";
const DEFAULT_AVATAR_PATH = fileURLToPath(new URL("../../assets/iris-avatar.png", import.meta.url));
const PAGE_SIZE = 8;

function richMessage(blocks: InputRichBlock[]): InputRichMessage {
  return { blocks };
}

async function showRichView(
  ctx: BotContext,
  deps: BotDependencies,
  blocks: InputRichBlock[],
  fallbackText: string,
  fallbackKeyboard: InlineKeyboard,
): Promise<void> {
  await editOrReplyRich(ctx, richMessage(blocks), fallbackText, {
    fallbackKeyboard,
    logger: deps.logger,
  });
}

function richPageButtons(page: number, pages: number, previousData: string, nextData: string): InputRichBlock {
  return richButtonRow([
    ...(page > 0 ? [richCallbackButton("◀ Previous", previousData)] : []),
    richCallbackButton(`${page + 1}/${pages}`, "noop"),
    ...(page + 1 < pages ? [richCallbackButton("Next ▶", nextData)] : []),
  ]);
}

export async function showHome(ctx: BotContext, deps: BotDependencies): Promise<void> {
  const user = ctx.from;
  await editOrReplyRich(ctx, richHomeMessage(user?.first_name), welcomeMessage(user?.first_name), {
    fallbackKeyboard: mainKeyboard(),
    logger: deps.logger,
  });
}

export async function sendWelcomeVideo(ctx: BotContext, deps: BotDependencies): Promise<void> {
  const text = welcomeMessage(ctx.from?.first_name);
  try {
    const home = richHomeMessage(ctx.from?.first_name);
    await ctx.replyWithRichMessage({
      blocks: [
        { type: "video", video: { type: "video", media: START_VIDEO_URL, supports_streaming: true } },
        ...(home.blocks ?? []),
      ],
    });
  } catch (error) {
    deps.logger.warn({ err: error }, "Rich welcome video could not be delivered; using a regular video");
    try {
      await ctx.replyWithVideo(START_VIDEO_URL, {
        caption: text,
        parse_mode: "HTML",
        reply_markup: mainKeyboard(),
        supports_streaming: true,
      });
    } catch (videoError) {
      deps.logger.warn({ err: videoError }, "Welcome video could not be delivered; using a text welcome");
      await ctx.reply(text, { parse_mode: "HTML", reply_markup: mainKeyboard() });
    }
  }
}

export async function showStore(ctx: BotContext, deps: BotDependencies): Promise<void> {
  const [categories, featured] = await Promise.all([
    listEnabledCategories(deps.database.prisma),
    listFeaturedProducts(deps.database.prisma, 0, 1),
  ]);
  const fallbackKeyboard = categories.length ? categoriesKeyboard(categories, featured.total) : mainKeyboard();
  const fallback = categories.length
    ? `🛍 <b>${smallCaps("Iris store")}</b>\n\n${smallCaps("Choose a category, browse featured items, or search the catalog.")}`
    : `🛍 <b>${smallCaps("Iris store")}</b>\n\n${smallCaps("The shelves are being arranged. Please check back soon.")}`;
  const blocks: InputRichBlock[] = [
    richHeading("🛍 Iris store", 1),
    richParagraph(categories.length
      ? "Choose a category, browse featured items, or search the catalog."
      : "The shelves are being arranged. Please check back soon.", true),
    ...(categories.length ? [richDataTable(
      ["Category", "Available items"],
      categories.map((category) => [`${category.emoji} ${category.name}`, category._count.products.toLocaleString("en-US")]),
      "Browse the catalog",
      ["left", "right"],
    )] : []),
    ...(featured.total > 0 ? [richButtonRow([richCallbackButton(`🔥 Featured items · ${featured.total}`, "store:featured:0", "primary")])] : []),
    ...categories.map((category) => richButtonRow([richCallbackButton(
      `${category.emoji} ${category.name} · ${category._count.products}`,
      `store:category:${category.id}:0`,
    )])),
    richButtonRow([
      richCallbackButton("🔍 Search", "store:search:start"),
      richCallbackButton("🏠 Home", "nav:home", "link"),
    ]),
  ];
  await showRichView(ctx, deps, blocks, fallback, fallbackKeyboard);
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
  if (page > 0) keyboard.text(smallCaps("◀"), `store:featured:${page - 1}`);
  keyboard.text(smallCaps(`${page + 1}/${result.pages}`), "noop");
  if (page + 1 < result.pages) keyboard.text(smallCaps("▶"), `store:featured:${page + 1}`);
  keyboard.row().text(smallCaps("◀ STORE"), "nav:store").text(smallCaps("🏠 HOME"), "nav:home");

  const description = result.products.length
    ? "Hand-picked popular items in the store."
    : "No featured items right now.";
  const fallback = `🔥 <b>${smallCaps("Featured products")}</b>\n\n${smallCaps(description)}`;
  const rows = result.products.map((product) => [
    `${product.emoji} ${product.name}`,
    product.category.name,
    creditLabel(product.price),
    product._count.inventory > 0 ? smallCaps("In stock") : smallCaps("Out of stock"),
  ]);
  const blocks: InputRichBlock[] = [
    richHeading("🔥 Featured products", 1),
    richParagraph(description, true),
    richDataTable(["Product", "Category", "Price", "Availability"], rows, "Featured selection", ["left", "left", "right", "center"]),
    ...result.products.map((product) => richButtonRow([richCallbackButton(
      `🔥 ${product.emoji} ${product.name}`,
      `store:product:${product.id}`,
      "primary",
    )])),
    ...(result.pages > 1 ? [richPageButtons(page, result.pages, `store:featured:${page - 1}`, `store:featured:${page + 1}`)] : []),
    richButtonRow([
      richCallbackButton("◀ Store", "nav:store", "link"),
      richCallbackButton("🏠 Home", "nav:home", "link"),
    ]),
  ];
  await showRichView(ctx, deps, blocks, fallback, keyboard);
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
  keyboard.text(smallCaps("🔍 NEW SEARCH"), "store:search:start").text(smallCaps("◀ STORE"), "nav:store").row().text(smallCaps("🏠 HOME"), "nav:home");

  const fallback = result.products.length
    ? `🔍 <b>${smallCaps("Search results for")} "${escapeHtml(query)}"</b>\n\n${result.total} ${smallCaps("matching product(s) found.")}`
    : `🔍 <b>${smallCaps("No results for")} "${escapeHtml(query)}"</b>\n\n${smallCaps("Try another keyword or browse the store categories.")}`;
  const rows = result.products.map((product) => [
    `${product.featured ? "🔥 " : ""}${product.emoji} ${product.name}`,
    product.category.name,
    creditLabel(product.price),
    product._count.inventory > 0 ? smallCaps("In stock") : smallCaps("Out of stock"),
  ]);
  const blocks: InputRichBlock[] = [
    richHeading(result.products.length ? "🔍 Search results" : "🔍 No search results", 1),
    richParagraph(`${smallCaps("Search query")}: ${query} · ${result.total} ${smallCaps("matching product(s)")}`),
    richDataTable(["Product", "Category", "Price", "Availability"], rows, "Catalog matches", ["left", "left", "right", "center"]),
    ...result.products.map((product) => richButtonRow([richCallbackButton(
      `${product.featured ? "🔥 " : ""}${product.emoji} ${product.name}`,
      `store:product:${product.id}`,
    )])),
    richButtonRow([
      richCallbackButton("🔍 New search", "store:search:start"),
      richCallbackButton("◀ Store", "nav:store", "link"),
      richCallbackButton("🏠 Home", "nav:home", "link"),
    ]),
  ];
  await showRichView(ctx, deps, blocks, fallback, keyboard);
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
  const fallback = result.products.length
    ? `${escapeHtml(category.emoji)} <b>${escapeHtml(smallCaps(category.name))}</b>\n\n${escapeHtml(category.description || smallCaps("Available digital goods"))}\n\n${smallCaps("Select an item to see details.")}`
    : `${escapeHtml(category.emoji)} <b>${escapeHtml(smallCaps(category.name))}</b>\n\n${smallCaps("No available products in this category yet.")}`;
  const rows = result.products.map((product) => [
    `${product.featured ? "🔥 " : ""}${product.emoji} ${product.name}`,
    creditLabel(product.price),
    product._count.inventory.toLocaleString("en-US"),
    product._count.inventory > 0 ? smallCaps("In stock") : smallCaps("Out of stock"),
  ]);
  const blocks: InputRichBlock[] = [
    richHeading(`${category.emoji} ${category.name}`, 1),
    ...(category.description.trim() ? [richParagraph(category.description.trim())] : []),
    richParagraph(result.products.length ? "Select an item to see details." : "No available products in this category yet.", true),
    richDataTable(["Product", "Price", "Stock", "Availability"], rows, "Category catalog", ["left", "right", "right", "center"]),
    ...result.products.map((product) => richButtonRow([richCallbackButton(
      `${product.featured ? "🔥 " : ""}${product.emoji} ${product.name}`,
      `store:product:${product.id}`,
    )])),
    ...(result.pages > 1 ? [richPageButtons(page, result.pages, `store:category:${categoryId}:${page - 1}`, `store:category:${categoryId}:${page + 1}`)] : []),
    richButtonRow([
      richCallbackButton("◀ Categories", "nav:store", "link"),
      richCallbackButton("🏠 Home", "nav:home", "link"),
    ]),
  ];
  await showRichView(ctx, deps, blocks, fallback, storeCategoryProductsKeyboard(result.products, categoryId, page, result.pages));
}

export async function showProduct(ctx: BotContext, deps: BotDependencies, productId: string): Promise<void> {
  const product = await getProduct(deps.database.prisma, productId);
  const currentUser = await findUserByTelegramId(deps.database.prisma, ctx.from!.id);
  const canBuy = product.enabled && product.deletedAt === null && product.category.enabled &&
    product.category.deletedAt === null && product._count.inventory > 0;
  const keyboard = new InlineKeyboard();
  const actions: Array<ReturnType<typeof richCallbackButton>> = [];
  if (canBuy) {
    const callbackData = `buy:start:${product.id}`;
    keyboard.text(smallCaps("🛒 Buy now"), callbackData).row();
    actions.push(richCallbackButton("🛒 Buy now", callbackData, "success"));
  } else {
    const subscribed = await isSubscribedToStock(deps.database.prisma, currentUser.id, product.id);
    const callbackData = `store:notify:${product.id}`;
    keyboard.text(smallCaps("⚠️ Out of stock"), "noop").row();
    keyboard.text(
      smallCaps(subscribed ? "🔕 Turn off restock alert" : "🔔 Notify me when available"),
      callbackData,
    ).row();
    actions.push(richCallbackButton(
      subscribed ? "🔕 Restock alert on" : "🔔 Notify me",
      callbackData,
      "primary",
    ));
  }
  if (product.mediaFileId) {
    const callbackData = `store:banner:${product.id}`;
    keyboard.text(smallCaps("🖼 View image"), callbackData).row();
    actions.push(richCallbackButton("🖼 View image", callbackData));
  }
  const backData = `store:category:${product.categoryId}:0`;
  keyboard.text(smallCaps("◀ Category"), backData).text(smallCaps("🏠 Home"), "nav:home");
  actions.push(richCallbackButton("◀ Back to category", backData, "link"));

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
  await editOrReplyRich(ctx, richProductMessage(card, actions), productMessage(card), {
    fallbackKeyboard: keyboard,
    logger: deps.logger,
  });
}

export async function showProfile(ctx: BotContext, deps: BotDependencies): Promise<void> {
  const user = await findUserByTelegramId(deps.database.prisma, ctx.from!.id);
  const settings = await getBonusSettings(deps.database.prisma, {
    credits: deps.config.bonusCredits,
    periodHours: deps.config.bonusPeriodHours,
  });
  const [purchaseCount, bonusStatus, referralSummary] = await Promise.all([
    countUserPurchases(deps.database.prisma, user.id),
    getBonusStatus(deps.database.prisma, user.id, settings.periodHours),
    getUserReferralSummary(deps.database.prisma, user.id),
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
    referralCount: referralSummary.totalReferrals,
    referralEarned: referralSummary.totalEarned,
    createdAt: user.createdAt,
    lastActiveAt: user.lastActiveAt,
    nextBonusAt: bonusStatus.nextAvailableAt,
    bonusAvailable: bonusStatus.available,
  });
  const photo = photoFileId
    ? photoFileId
    : new InputFile(await readFile(DEFAULT_AVATAR_PATH), "iris-avatar.png");
  const richPhoto: InputRichBlock = {
    type: "photo",
    photo: { type: "photo", media: photo },
    caption: { text: smallCaps("Private account card") },
  };
  const nextBonus = bonusStatus.available
    ? smallCaps("Ready to claim")
    : bonusStatus.nextAvailableAt ? formatDate(bonusStatus.nextAvailableAt) : smallCaps("Not set");
  const referralSummaryText = referralSummary.totalEarned > 0
    ? `${referralSummary.totalReferrals.toLocaleString("en-US")} (+${creditLabel(referralSummary.totalEarned)})`
    : referralSummary.totalReferrals.toLocaleString("en-US");
  const blocks: InputRichBlock[] = [
    richPhoto,
    richHeading([smallCaps("👤 Profile · "), displayName], 1),
    richKeyValueTable([
      ["Username", ctx.from?.username ? `@${ctx.from.username}` : smallCaps("Not set")],
      ["Telegram ID", { type: "code", text: ctx.from!.id.toString() }],
      ["Credits", creditLabel(user.credits)],
      ["Purchases", purchaseCount.toLocaleString("en-US")],
      ["Referrals", referralSummaryText],
      ["Joined", formatDate(user.createdAt)],
      ["Last active", formatDate(user.lastActiveAt)],
      ["Daily bonus", bonusStatus.available ? smallCaps("Ready to claim") : smallCaps("Claimed")],
      ["Next bonus", nextBonus],
    ], "Account profile"),
    richButtonRow([
      richCallbackButton("🛍 Store", "nav:store"),
      richCallbackButton("💳 Wallet", "nav:wallet"),
    ]),
    richButtonRow([
      richCallbackButton("🎁 Bonus", "nav:bonus"),
      richCallbackButton("🤝 Refer & earn", "nav:refer"),
    ]),
    richButtonRow([
      richCallbackButton("📦 Orders", "nav:orders"),
      richCallbackButton("◀ Main menu", "nav:home", "link"),
    ]),
  ];
  await showRichView(ctx, deps, blocks, caption, profileKeyboard());
}

const CREDIT_TYPE_ICONS: Record<string, string> = {
  BONUS: "🎁",
  GIFT: "🎉",
  GIFT_ALL: "🎊",
  REDEEM: "🎟️",
  PURCHASE: "🛍️",
  REFUND: "↩️",
  ADMIN_ADJUSTMENT: "⚙️",
  REFERRAL: "🤝",
};

export async function showWallet(ctx: BotContext, deps: BotDependencies, requestedPage = 0): Promise<void> {
  const user = await findUserByTelegramId(deps.database.prisma, ctx.from!.id);
  const history = await listUserCreditTransactions(deps.database.prisma, user.id, requestedPage, PAGE_SIZE);
  const balance = `💰 <b>${smallCaps("Available balance")}:</b> ${creditLabel(user.credits)}`;
  const keyboard = new InlineKeyboard();

  if (history.total === 0) {
    keyboard
      .text(smallCaps("🎁 CLAIM BONUS"), "nav:bonus")
      .text(smallCaps("🛍 STORE"), "nav:store")
      .row()
      .text(smallCaps("🏠 HOME"), "nav:home");
    const fallback = `💳 <b>${smallCaps("Wallet activity")}</b>\n\n${balance}\n\n${smallCaps("No credit activity yet. Claim a bonus or explore the store to get started.")}`;
    const blocks: InputRichBlock[] = [
      richHeading("💳 Wallet activity", 1),
      richKeyValueTable([["Available balance", creditLabel(user.credits)]], "Current balance"),
      richParagraph("No credit activity yet. Claim a bonus or explore the store to get started.", true),
      richButtonRow([
        richCallbackButton("🎁 Claim bonus", "nav:bonus", "success"),
        richCallbackButton("🛍 Store", "nav:store", "primary"),
      ]),
      richButtonRow([richCallbackButton("🏠 Home", "nav:home", "link")]),
    ];
    await showRichView(ctx, deps, blocks, fallback, keyboard);
    return;
  }

  const rows = history.transactions.map((transaction) => {
    const amount = transaction.amount > 0
      ? `+${creditLabel(transaction.amount)}`
      : transaction.amount < 0
        ? `−${creditLabel(Math.abs(transaction.amount))}`
        : creditLabel(0);
    const icon = CREDIT_TYPE_ICONS[transaction.type] ?? "✦";
    return [
      `${icon} ${truncate(transaction.description, 72)}`,
      amount,
      creditLabel(transaction.balanceAfter),
      formatDate(transaction.createdAt),
    ];
  });
  if (history.pages > 1) {
    if (history.page > 0) keyboard.text(smallCaps("◀"), `wallet:page:${history.page - 1}`);
    keyboard.text(smallCaps(`${history.page + 1}/${history.pages}`), "noop");
    if (history.page + 1 < history.pages) keyboard.text(smallCaps("▶"), `wallet:page:${history.page + 1}`);
    keyboard.row();
  }
  keyboard
    .text(smallCaps("🎁 BONUS"), "nav:bonus")
    .text(smallCaps("🛍 STORE"), "nav:store")
    .row()
    .text(smallCaps("📦 ORDERS"), "nav:orders")
    .text(smallCaps("🏠 HOME"), "nav:home");

  const fallbackEntries = history.transactions.map((transaction) => {
    const amount = transaction.amount > 0
      ? `+${creditLabel(transaction.amount)}`
      : transaction.amount < 0
        ? `−${creditLabel(Math.abs(transaction.amount))}`
        : creditLabel(0);
    const icon = CREDIT_TYPE_ICONS[transaction.type] ?? "✦";
    return `${icon} <b>${escapeHtml(truncate(transaction.description, 72))}</b>\n${amount} · ${smallCaps("Balance")}: ${creditLabel(transaction.balanceAfter)}\n<i>${escapeHtml(formatDate(transaction.createdAt))}</i>`;
  });
  const fallback = `💳 <b>${smallCaps("Wallet activity")}</b>\n\n${balance}\n\n${smallCaps("Recent credit activity · newest first")}\n\n${fallbackEntries.join("\n\n")}`;
  const blocks: InputRichBlock[] = [
    richHeading("💳 Wallet activity", 1),
    richKeyValueTable([["Available balance", creditLabel(user.credits)]], "Current balance"),
    richDataTable(["Activity", "Change", "Balance after", "Date"], rows, "Recent credit ledger", ["left", "right", "right", "right"]),
    ...(history.pages > 1 ? [richPageButtons(history.page, history.pages, `wallet:page:${history.page - 1}`, `wallet:page:${history.page + 1}`)] : []),
    richButtonRow([
      richCallbackButton("🎁 Bonus", "nav:bonus"),
      richCallbackButton("🛍 Store", "nav:store", "primary"),
      richCallbackButton("📦 Orders", "nav:orders"),
      richCallbackButton("🏠 Home", "nav:home", "link"),
    ]),
  ];
  await showRichView(ctx, deps, blocks, fallback, keyboard);
}

export async function showBonusStatus(ctx: BotContext, deps: BotDependencies): Promise<void> {
  const user = await findUserByTelegramId(deps.database.prisma, ctx.from!.id);
  const settings = await getBonusSettings(deps.database.prisma, {
    credits: deps.config.bonusCredits,
    periodHours: deps.config.bonusPeriodHours,
  });
  const status = await getBonusStatus(deps.database.prisma, user.id, settings.periodHours);
  const keyboard = status.available
    ? new InlineKeyboard().text(smallCaps("🎁 CLAIM BONUS"), "bonus:claim").row().text(smallCaps("◀ HOME"), "nav:home")
    : new InlineKeyboard().text(smallCaps("◀ HOME"), "nav:home");
  const body = status.available
    ? `🎁 <b>${smallCaps("Daily bonus ready")}</b>\n\n${smallCaps("Claim your credits and keep exploring Iris.")}\n\n💳 ${creditLabel(settings.credits)}`
    : `🎁 <b>${smallCaps("Bonus claimed")}</b>\n\n${smallCaps("Next bonus in")} ${formatDuration(status.remainingMs)}\n${smallCaps("Available at")} ${escapeHtml(formatDate(status.nextAvailableAt))}`;
  const rows: Array<[string, RichText]> = [
    ["Status", status.available ? smallCaps("Ready to claim") : smallCaps("Already claimed")],
    ["Reward", creditLabel(settings.credits)],
    ["Cooldown", `${settings.periodHours} ${smallCaps("hours")}`],
    ["Next available", status.available ? smallCaps("Now") : formatDate(status.nextAvailableAt)],
  ];
  const blocks: InputRichBlock[] = [
    richHeading(status.available ? "🎁 Daily bonus ready" : "🎁 Bonus claimed", 1),
    richKeyValueTable(rows, "Bonus status"),
    richParagraph(status.available
      ? "Claim your credits and keep exploring Iris."
      : `Next bonus in ${formatDuration(status.remainingMs)}.`, true),
    richButtonRow(status.available
      ? [richCallbackButton("🎁 Claim bonus", "bonus:claim", "success"), richCallbackButton("🏠 Home", "nav:home", "link")]
      : [richCallbackButton("🏠 Home", "nav:home", "link")]),
  ];
  await showRichView(ctx, deps, blocks, body, keyboard);
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
    const blocks: InputRichBlock[] = [
      richHeading("🎉 Bonus collected", 1),
      richKeyValueTable([
        ["Credits received", `+${creditLabel(result.creditsReceived)}`],
        ["New balance", creditLabel(result.balance)],
        ["Next bonus", formatDate(result.nextAvailableAt)],
      ], "Bonus receipt"),
      richFooter("Your next reward will be ready after the cooldown." , true),
      richButtonRow([
        richCallbackButton("🛍 Store", "nav:store", "primary"),
        richCallbackButton("👤 Profile", "nav:profile"),
        richCallbackButton("🏠 Home", "nav:home", "link"),
      ]),
    ];
    await showRichView(ctx, deps, blocks, text, mainKeyboard());
  } catch (error) {
    if (!(error instanceof BonusUnavailableError || error instanceof DomainError)) throw error;
    const text = error instanceof BonusUnavailableError
      ? `🎁 ${smallCaps("Your bonus is already claimed.")}\n\n${smallCaps("Next available")} ${escapeHtml(formatDate(error.nextAvailableAt))}`
      : `⚠️ ${escapeHtml(error.message)}`;
    const blocks: InputRichBlock[] = error instanceof BonusUnavailableError
      ? [
          richHeading("🎁 Bonus already claimed", 1),
          richKeyValueTable([
            ["Next available", formatDate(error.nextAvailableAt)],
            ["Cooldown", `${settings.periodHours} ${smallCaps("hours")}`],
          ], "Bonus status"),
          richButtonRow([
            richCallbackButton("🛍 Store", "nav:store", "primary"),
            richCallbackButton("🏠 Home", "nav:home", "link"),
          ]),
        ]
      : [
          richHeading("⚠️ Bonus unavailable", 1),
          richParagraph(smallCaps(error.message)),
          richButtonRow([richCallbackButton("🏠 Home", "nav:home", "link")]),
        ];
    await showRichView(ctx, deps, blocks, text, mainKeyboard());
  }
  void edit;
}

export async function showOrders(ctx: BotContext, deps: BotDependencies, page = 0): Promise<void> {
  const user = await findUserByTelegramId(deps.database.prisma, ctx.from!.id);
  const [purchases, total] = await Promise.all([
    listUserPurchases(deps.database.prisma, user.id, Math.max(0, page) * PAGE_SIZE, PAGE_SIZE),
    deps.database.prisma.purchase.count({ where: { buyerId: user.id } }),
  ]);
  if (!purchases.length) {
    const fallback = `📦 <b>${smallCaps("No purchases yet")}</b>\n\n${smallCaps("Your next favorite find is waiting in the store.")}`;
    await showRichView(ctx, deps, [
      richHeading("📦 No purchases yet", 1),
      richParagraph("Your next favorite find is waiting in the store.", true),
      richButtonRow([
        richCallbackButton("🛍 Browse store", "nav:store", "primary"),
        richCallbackButton("🏠 Home", "nav:home", "link"),
      ]),
    ], fallback, mainKeyboard());
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
    if (page > 0) keyboard.text(smallCaps("◀"), `orders:page:${page - 1}`);
    keyboard.text(smallCaps(`${page + 1}/${pages}`), "noop");
    if (page + 1 < pages) keyboard.text(smallCaps("▶"), `orders:page:${page + 1}`);
    keyboard.row();
  }
  keyboard.text(smallCaps("🛍 STORE"), "nav:store").text(smallCaps("🏠 HOME"), "nav:home");

  const lines = purchases.map((purchase) =>
    `• ${escapeHtml(purchase.product.emoji)} <b>${escapeHtml(purchase.product.name)}</b> — ${creditLabel(purchase.amountPaid)}\n  <code>#${escapeHtml(purchase.id.slice(0, 8))}</code> · ${escapeHtml(formatDate(purchase.createdAt))}`,
  );
  await editOrReplyRich(
    ctx,
    richOrderHistoryMessage(purchases, total, page, pages),
    `📦 <b>${smallCaps("Your Order Vault")}</b> · ${total}\n\n${smallCaps("Tap any order below to view its email, password, delivery details, or download a .txt receipt. Eligible delivery issues may be reviewed for replacement; refunds are not offered.")}\n\n${lines.join("\n\n")}`,
    { fallbackKeyboard: keyboard, logger: deps.logger },
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

  const receiptData = `order:txt:${purchase.id}`;
  const keyboard = new InlineKeyboard().text(smallCaps("📄 Download receipt"), receiptData);
  const actions: Array<ReturnType<typeof richCallbackButton>> = [
    richCallbackButton("📄 Download receipt", receiptData, "primary"),
  ];
  if (warrantyActive && !purchase.warrantyClaim) {
    const claimData = `order:warranty:${purchase.id}`;
    keyboard.text(smallCaps("🛠 Report issue"), claimData);
    actions.push(richCallbackButton("🛠 Report issue", claimData, "danger"));
  }
  keyboard.row().text(smallCaps("◀ My orders"), "nav:orders").text(smallCaps("🏠 Home"), "nav:home");
  actions.push(richCallbackButton("◀ My orders", "nav:orders", "link"));

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
      actions,
    }),
    sections.join("\n\n"),
    { fallbackKeyboard: keyboard, logger: deps.logger },
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
  const receipt = Buffer.from(receiptText, "utf8");
  const caption = `📄 ${smallCaps("Order receipt")} · #${purchase.id.slice(0, 8)}`;
  try {
    await ctx.replyWithRichMessage({
      blocks: [
        richHeading("📄 Order receipt"),
        richParagraph("Your private text copy is ready to save.", true),
        {
          type: "document",
          document: { type: "document", media: new InputFile(receipt, filename) },
          caption: { text: caption },
        },
      ],
    });
  } catch (error) {
    deps.logger.debug({ err: error }, "Rich receipt block could not be sent; using a regular document");
    await ctx.replyWithDocument(new InputFile(receipt, filename), {
      caption: `📄 <b>${smallCaps("Order receipt")}</b> · <code>#${escapeHtml(purchase.id.slice(0, 8))}</code>`,
      parse_mode: "HTML",
    });
  }
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
    .text(smallCaps("❌ Invalid Email / Password"), `order:claim:${purchase.id}:invalid_creds`)
    .row()
    .text(smallCaps("🔒 Account Locked / 2FA"), `order:claim:${purchase.id}:locked`)
    .row()
    .text(smallCaps("📉 Plan Expired / Free Tier"), `order:claim:${purchase.id}:expired`)
    .row()
    .text(smallCaps("◀ BACK TO ORDER"), `order:view:${purchase.id}`);

  const text = `🛠 <b>${smallCaps("Report a delivery issue")}</b>\n\n` +
    `📦 <b>${escapeHtml(purchase.product.emoji)} ${escapeHtml(smallCaps(purchase.product.name))}</b> (<code>#${escapeHtml(purchase.id.slice(0, 8))}</code>)\n\n` +
    `${smallCaps("Select a reason below, or describe what went wrong. Approved issues may receive a stock replacement only; refunds are not offered.")}`;
  const blocks: InputRichBlock[] = [
    richHeading("🛠 Report a delivery issue", 1),
    richKeyValueTable([
      ["Product", `${purchase.product.emoji} ${purchase.product.name}`],
      ["Order", `#${purchase.id.slice(0, 8)}`],
      ["Policy", smallCaps("Approved issues may receive a stock replacement; refunds are not offered.")],
    ], "Order reference"),
    richParagraph("Select a reason below, or describe what went wrong.", true),
    richButtonRow([
      richCallbackButton("❌ Invalid email / password", `order:claim:${purchase.id}:invalid_creds`, "danger"),
    ]),
    richButtonRow([
      richCallbackButton("🔒 Account locked / 2FA", `order:claim:${purchase.id}:locked`, "danger"),
    ]),
    richButtonRow([
      richCallbackButton("📉 Plan expired / free tier", `order:claim:${purchase.id}:expired`, "danger"),
    ]),
    richButtonRow([richCallbackButton("◀ Back to order", `order:view:${purchase.id}`, "link")]),
  ];
  await showRichView(ctx, deps, blocks, text, keyboard);
}

export async function showReferrals(ctx: BotContext, deps: BotDependencies): Promise<void> {
  const user = await findUserByTelegramId(deps.database.prisma, ctx.from!.id);
  const [settings, summary] = await Promise.all([
    getReferralSettings(deps.database.prisma, {
      referrerCredits: deps.config.referralRewardCredits,
      inviteeCredits: deps.config.referralWelcomeCredits,
    }),
    getUserReferralSummary(deps.database.prisma, user.id),
  ]);

  const botUsername = ctx.me?.username || "IrisStoreBot";
  const referralLink = buildReferralLink(botUsername, user.telegramId);
  const shareUrl = buildReferralShareUrl(referralLink, settings.inviteeCredits);

  const keyboard = new InlineKeyboard()
    .url(smallCaps("📤 SHARE INVITE LINK"), shareUrl)
    .row()
    .text(smallCaps(`👥 MY REFERRALS (${summary.totalReferrals})`), "refer:list:0")
    .text(smallCaps("💳 WALLET"), "nav:wallet")
    .row()
    .text(smallCaps("🛍 STORE"), "nav:store")
    .text(smallCaps("🏠 HOME"), "nav:home");

  const statusLabel = settings.enabled ? smallCaps("Active") : smallCaps("Paused");
  const friendRewardLabel = settings.inviteeCredits > 0
    ? `+${creditLabel(settings.inviteeCredits)} ${smallCaps("on join")}`
    : smallCaps("None");
  const referrerRewardLabel = settings.referrerCredits > 0
    ? `+${creditLabel(settings.referrerCredits)} ${smallCaps("per friend")}`
    : smallCaps("None");

  const referredByLine = summary.referredBy
    ? `\n🤝 <b>${smallCaps("Invited by")}:</b> ${
        summary.referredBy.username
          ? `@${escapeHtml(summary.referredBy.username)}`
          : escapeHtml(summary.referredBy.firstName || `ID ${summary.referredBy.telegramId.toString()}`)
      }`
    : "";

  const fallback = `🤝 <b>${smallCaps("Refer & earn")}</b>\n\n` +
    `${smallCaps(
      settings.enabled
        ? "Invite friends with your personal link. Credits are granted automatically as soon as a new user starts Iris from your invite link."
        : "Referral rewards are currently paused by the store owner.",
    )}\n\n` +
    `🔗 <b>${smallCaps("Your invite link")}:</b>\n<code>${escapeHtml(referralLink)}</code>\n\n` +
    `✦ <b>${smallCaps("Your reward")}:</b> ${referrerRewardLabel}\n` +
    `🎁 <b>${smallCaps("Friend welcome bonus")}:</b> ${friendRewardLabel}\n` +
    `👥 <b>${smallCaps("Friends referred")}:</b> ${summary.totalReferrals}\n` +
    `💰 <b>${smallCaps("Total earned")}:</b> ${creditLabel(summary.totalEarned)}` +
    referredByLine;

  const tableRows: Array<[string, RichText]> = [
    ["Status", statusLabel],
    ["Your reward", referrerRewardLabel],
    ["Friend welcome bonus", friendRewardLabel],
    ["Friends referred", summary.totalReferrals.toLocaleString("en-US")],
    ["Total earned", creditLabel(summary.totalEarned)],
    ...(summary.referredBy
      ? [[
          "Invited by",
          summary.referredBy.username
            ? `@${summary.referredBy.username}`
            : summary.referredBy.firstName || `User ${summary.referredBy.telegramId.toString()}`,
        ] as [string, RichText]]
      : []),
    ["Invite link", { type: "code", text: referralLink }],
  ];

  const blocks: InputRichBlock[] = [
    richHeading("🤝 Refer & earn", 1),
    richParagraph(
      settings.enabled
        ? "Share your personal invite link. When a brand-new friend starts Iris using your link, rewards are credited automatically."
        : "The referral program is currently paused by the store owner.",
      true,
    ),
    richKeyValueTable(tableRows, "Referral program"),
    richButtonRow([
      { text: smallCaps("📤 Share invite link"), url: shareUrl },
      richCallbackButton(`👥 My referrals · ${summary.totalReferrals}`, "refer:list:0", "primary"),
    ]),
    richButtonRow([
      richCallbackButton("💳 Wallet", "nav:wallet"),
      richCallbackButton("🛍 Store", "nav:store"),
      richCallbackButton("🏠 Home", "nav:home", "link"),
    ]),
    richFooter(smallCaps("Only new users joining Iris for the first time count toward referral rewards. Self-referrals are ignored.")),
  ];

  await showRichView(ctx, deps, blocks, fallback, keyboard);
}

export async function showMyReferrals(
  ctx: BotContext,
  deps: BotDependencies,
  requestedPage = 0,
): Promise<void> {
  const user = await findUserByTelegramId(deps.database.prisma, ctx.from!.id);
  const [settings, list] = await Promise.all([
    getReferralSettings(deps.database.prisma, {
      referrerCredits: deps.config.referralRewardCredits,
      inviteeCredits: deps.config.referralWelcomeCredits,
    }),
    listUserReferrals(deps.database.prisma, user.id, requestedPage, PAGE_SIZE),
  ]);

  const botUsername = ctx.me?.username || "IrisStoreBot";
  const referralLink = buildReferralLink(botUsername, user.telegramId);
  const shareUrl = buildReferralShareUrl(referralLink, settings.inviteeCredits);

  const keyboard = new InlineKeyboard();
  if (list.pages > 1) {
    if (list.page > 0) keyboard.text(smallCaps("◀"), `refer:list:${list.page - 1}`);
    keyboard.text(smallCaps(`${list.page + 1}/${list.pages}`), "noop");
    if (list.page + 1 < list.pages) keyboard.text(smallCaps("▶"), `refer:list:${list.page + 1}`);
    keyboard.row();
  }
  keyboard
    .url(smallCaps("📤 SHARE INVITE LINK"), shareUrl)
    .row()
    .text(smallCaps("◀ REFER & EARN"), "nav:refer")
    .text(smallCaps("🏠 HOME"), "nav:home");

  if (list.total === 0) {
    const fallback = `👥 <b>${smallCaps("My referrals")}</b>\n\n` +
      `${smallCaps("No friends have joined from your invite link yet.")}\n\n` +
      `🔗 <b>${smallCaps("Your invite link")}:</b>\n<code>${escapeHtml(referralLink)}</code>`;
    const blocks: InputRichBlock[] = [
      richHeading("👥 My referrals", 1),
      richKeyValueTable([
        ["Friends referred", "0"],
        ["Total earned", creditLabel(0)],
        ["Invite link", { type: "code", text: referralLink }],
      ], "Referral summary"),
      richParagraph("No friends have joined from your invite link yet. Share your link below to start earning credits!", true),
      richButtonRow([
        { text: smallCaps("📤 Share invite link"), url: shareUrl },
      ]),
      richButtonRow([
        richCallbackButton("◀ Refer & earn", "nav:refer", "link"),
        richCallbackButton("🏠 Home", "nav:home", "link"),
      ]),
    ];
    await showRichView(ctx, deps, blocks, fallback, keyboard);
    return;
  }

  const formatReferredFriend = (item: (typeof list.referrals)[number]): string => {
    const fullName = [item.firstName, item.lastName].filter(Boolean).join(" ").trim();
    if (fullName && item.username) return `${fullName} (@${item.username})`;
    if (item.username) return `@${item.username}`;
    if (fullName) return fullName;
    const rawId = item.telegramId.toString();
    return `User ···${rawId.slice(-4)}`;
  };

  const rows = list.referrals.map((item) => [
    truncate(formatReferredFriend(item), 48),
    `+${creditLabel(item.referralRewardCredits)}`,
    formatDate(item.referredAt ?? item.createdAt),
  ]);

  const fallbackLines = list.referrals.map((item) => {
    const label = escapeHtml(truncate(formatReferredFriend(item), 48));
    return `• <b>${label}</b> — +${creditLabel(item.referralRewardCredits)}\n  <i>${escapeHtml(formatDate(item.referredAt ?? item.createdAt))}</i>`;
  });

  const fallback = `👥 <b>${smallCaps("My referrals")}</b> · ${list.total}\n\n` +
    `💰 <b>${smallCaps("Total earned")}:</b> ${creditLabel(list.totalEarned)}\n\n` +
    `${fallbackLines.join("\n\n")}`;

  const blocks: InputRichBlock[] = [
    richHeading(`👥 My referrals · ${list.total}`, 1),
    richKeyValueTable([
      ["Friends referred", list.total.toLocaleString("en-US")],
      ["Total earned", creditLabel(list.totalEarned)],
    ], "Referral summary"),
    richDataTable(["Friend", "Reward", "Joined"], rows, "Referred friends", ["left", "right", "right"]),
    ...(list.pages > 1
      ? [richPageButtons(list.page, list.pages, `refer:list:${list.page - 1}`, `refer:list:${list.page + 1}`)]
      : []),
    richButtonRow([
      { text: smallCaps("📤 Share invite link"), url: shareUrl },
    ]),
    richButtonRow([
      richCallbackButton("◀ Refer & earn", "nav:refer", "link"),
      richCallbackButton("💳 Wallet", "nav:wallet"),
      richCallbackButton("🏠 Home", "nav:home", "link"),
    ]),
  ];

  await showRichView(ctx, deps, blocks, fallback, keyboard);
}

export async function showHelp(ctx: BotContext, deps: BotDependencies): Promise<void> {
  await editOrReplyRich(ctx, richHelpMessage(), helpMessage(), {
    fallbackKeyboard: mainKeyboard(),
    logger: deps.logger,
  });
}

export function parsePositiveInteger(raw: string, label: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive whole number.`);
  return value;
}
