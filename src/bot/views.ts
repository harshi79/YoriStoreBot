import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { InlineKeyboard, InputFile } from "grammy";
import type { InputMediaPhoto } from "grammy/types";
import { listUserPurchases } from "../services/purchases.service.js";
import { getBonusSettings } from "../services/settings.service.js";
import {
  getProduct,
  listCategoryProducts,
  listEnabledCategories,
} from "../services/store.service.js";
import { countUserPurchases, findUserByTelegramId, saveProfilePhoto } from "../services/users.service.js";
import { helpMessage, productMessage, profileMessage, welcomeMessage } from "../messages/iris.js";
import { categoriesKeyboard, mainKeyboard, profileKeyboard, storeCategoryProductsKeyboard } from "../keyboards/inline.js";
import { editOrReply, isUnchangedEdit } from "./render.js";
import type { BotContext } from "../types/context.js";
import type { BotDependencies } from "./dependencies.js";
import { creditLabel, escapeHtml, formatDate, formatDuration, smallCaps } from "../utils/format.js";
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
  const categories = await listEnabledCategories(deps.database.prisma);
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
    `🛍 <b>${smallCaps("Iris store")}</b>\n\n${smallCaps("Choose a category to explore.")}`,
    categoriesKeyboard(categories),
    deps.logger,
  );
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
  if (canBuy) keyboard.text("🛒 BUY", `buy:start:${product.id}`).row();
  else keyboard.text("⚠️ OUT OF STOCK", "noop").row();
  keyboard.text("◀ BACK", `store:category:${product.categoryId}:0`).text("🏠 HOME", "nav:home");
  await editOrReply(
    ctx,
    productMessage({
      emoji: product.emoji,
      name: product.name,
      category: product.category.name,
      description: product.description,
      price: product.price,
      stock: product._count.inventory,
      credits: currentUser.credits,
    }),
    keyboard,
    deps.logger,
  );
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

export async function showOrders(ctx: BotContext, deps: BotDependencies): Promise<void> {
  const user = await findUserByTelegramId(deps.database.prisma, ctx.from!.id);
  const purchases = await listUserPurchases(deps.database.prisma, user.id, 0, 10);
  if (!purchases.length) {
    await editOrReply(
      ctx,
      `📦 <b>${smallCaps("No purchases yet")}</b>\n\n${smallCaps("Your next favorite find is waiting in the store.")}`,
      mainKeyboard(),
      deps.logger,
    );
    return;
  }
  const lines = purchases.map((purchase) =>
    `• ${escapeHtml(purchase.product.emoji)} ${escapeHtml(purchase.product.name)} — ${creditLabel(purchase.amountPaid)}\n  ${escapeHtml(formatDate(purchase.createdAt))}`,
  );
  await editOrReply(
    ctx,
    `📦 <b>${smallCaps("Your purchases")}</b>\n\n${lines.join("\n\n")}`,
    mainKeyboard(),
    deps.logger,
  );
}

export async function showHelp(ctx: BotContext, deps: BotDependencies): Promise<void> {
  await editOrReply(ctx, helpMessage(), mainKeyboard(), deps.logger);
}

export function parsePositiveInteger(raw: string, label: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive whole number.`);
  return value;
}
