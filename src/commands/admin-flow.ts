import { InlineKeyboard } from "grammy";
import type { Bot } from "grammy";
import type { BotContext } from "../types/context.js";
import type { AdminFlow } from "../types/session.js";
import type { BotDependencies } from "../bot/dependencies.js";
import { isOwner, requirePrivate } from "../bot/authorization.js";
import { categoryDetailKeyboard, productDetailKeyboard } from "../keyboards/inline.js";
import {
  addInventoryItems,
  consumeStockSubscribers,
  createCategory,
  createProduct,
  getProduct,
  updateCategory,
  updateProduct,
} from "../services/store.service.js";
import { submitWarrantyClaim } from "../services/purchases.service.js";
import { findUserByTelegramId } from "../services/users.service.js";
import { updateBonusSettings, updateReferralSettings } from "../services/settings.service.js";
import { showProductAdmin } from "../bot/admin-views.js";
import { showOrderDetail, showStoreSearchResults } from "../bot/views.js";
import { creditLabel, escapeHtml, smallCaps } from "../utils/format.js";
import { DomainError, ValidationError } from "../utils/errors.js";
import {
  editMessageRichOrLegacy,
  editOrReply,
  replyRichOrLegacy,
  richHtmlMessage,
  sendRichOrLegacy,
} from "../bot/render.js";
import {
  richButtonRow,
  richCallbackButton,
  richHeading,
  richKeyValueTable,
  richParagraph,
} from "../messages/rich-ui.js";

export async function notifyRestockSubscribers(
  ctx: BotContext,
  deps: BotDependencies,
  productId: string,
): Promise<number> {
  const product = await getProduct(deps.database.prisma, productId);
  if (!product.enabled || product._count.inventory <= 0) return 0;
  const subscribers = await consumeStockSubscribers(deps.database.prisma, productId);
  if (!subscribers.length) return 0;

  let notified = 0;
  const alertText = `🔔 <b>${smallCaps("Restock alert")}</b>\n\n` +
    `${escapeHtml(product.emoji)} <b>${escapeHtml(product.name)}</b> ${smallCaps("is back in stock!")}\n` +
    (product.planDetails ? `💎 ${escapeHtml(product.planDetails)}\n` : "") +
    `💳 ${smallCaps("Price")}: ${creditLabel(product.price)}\n` +
    `📦 ${smallCaps("Available")}: ${product._count.inventory}`;
  const keyboard = new InlineKeyboard()
    .text(smallCaps("🛍 View product"), `store:product:${product.id}`)
    .text(smallCaps("🏠 Home"), "nav:home");
  const richAlert = {
    blocks: [
      richHeading([smallCaps("🔔 Restock alert · "), `${product.emoji} `, product.name], 1),
      richParagraph("An item on your watchlist is back in stock.", true),
      richKeyValueTable([
        ["Price", creditLabel(product.price)],
        ...(product.planDetails ? [["Plan / specs", product.planDetails] as const] : []),
        ["Available", product._count.inventory.toLocaleString("en-US")],
      ], "Stock availability"),
      richButtonRow([
        richCallbackButton("🛍 View product", `store:product:${product.id}`, "primary"),
        richCallbackButton("🏠 Home", "nav:home", "link"),
      ]),
    ],
  };

  for (const subscriber of subscribers) {
    try {
      await sendRichOrLegacy(ctx, Number(subscriber.telegramId), richAlert, alertText, {
        fallbackKeyboard: keyboard,
        logger: deps.logger,
      });
      notified++;
    } catch (error) {
      deps.logger.debug({ err: error, telegramId: subscriber.telegramId.toString() }, "Could not deliver restock alert");
    }
  }
  return notified;
}

export async function handleUserWarrantySubmission(
  ctx: BotContext,
  deps: BotDependencies,
  purchaseId: string,
  reason: string,
): Promise<void> {
  const user = await findUserByTelegramId(deps.database.prisma, ctx.from!.id);
  const claim = await submitWarrantyClaim(deps.database.prisma, user.id, purchaseId, reason);
  ctx.session.userFlow = null;

  const ownerKeyboard = new InlineKeyboard()
    .text(smallCaps("🔄 Replace from stock"), `admin:warranty:replace:${claim.id}`)
    .text(smallCaps("❌ Reject issue"), `admin:warranty:reject:${claim.id}`)
    .row()
    .text(smallCaps("🛡 View claim"), `admin:warranty:view:${claim.id}`);

  const buyerLabel = claim.buyer.username
    ? `@${escapeHtml(claim.buyer.username)} (<code>${claim.buyer.telegramId.toString()}</code>)`
    : `<code>${claim.buyer.telegramId.toString()}</code>`;

  const ownerAlertText = `🛡 <b>${smallCaps("New warranty claim")}</b>\n\n` +
    `<b>${smallCaps("Product")}:</b> ${escapeHtml(claim.product.emoji)} ${escapeHtml(claim.product.name)}\n` +
    `<b>${smallCaps("Buyer")}:</b> ${buyerLabel}\n` +
    `<b>${smallCaps("Order")}:</b> <code>#${escapeHtml(claim.purchaseId.slice(0, 8))}</code> (${creditLabel(claim.purchase.amountPaid)})\n` +
    `<b>${smallCaps("Reason")}:</b> ${escapeHtml(claim.reason)}`;
  await sendRichOrLegacy(ctx, Number(deps.config.ownerId), {
    blocks: [
      richHeading("🛡 New warranty claim", 1),
      richKeyValueTable([
        ["Product", `${claim.product.emoji} ${claim.product.name}`],
        ["Buyer", claim.buyer.username ? `@${claim.buyer.username} · ${claim.buyer.telegramId}` : claim.buyer.telegramId.toString()],
        ["Order", `#${claim.purchaseId.slice(0, 8)}`],
        ["Paid", creditLabel(claim.purchase.amountPaid)],
      ], "Claim reference"),
      { type: "expandable_blockquote", text: claim.reason, credit: smallCaps("Customer report") },
      richButtonRow([
        richCallbackButton("🔄 Replace from stock", `admin:warranty:replace:${claim.id}`, "success"),
        richCallbackButton("❌ Reject issue", `admin:warranty:reject:${claim.id}`, "danger"),
      ]),
      richButtonRow([richCallbackButton("🛡 View claim", `admin:warranty:view:${claim.id}`, "link")]),
    ],
  }, ownerAlertText, {
    fallbackKeyboard: ownerKeyboard,
    logger: deps.logger,
  }).catch((error: unknown) => {
    deps.logger.warn({ err: error }, "Could not send warranty claim alert to owner");
  });

  await showOrderDetail(ctx, deps, purchaseId);
}

export async function beginAdminFlow(
  ctx: BotContext,
  deps: BotDependencies,
  flow: AdminFlow,
  prompt: string,
): Promise<void> {
  ctx.session.adminFlow = flow;
  const message = ctx.callbackQuery?.message;
  if (message && "message_id" in message && message.date !== 0) {
    ctx.session.adminPanelChatId = message.chat.id;
    ctx.session.adminPanelMessageId = message.message_id;
    await editOrReply(ctx, prompt, cancelFlowKeyboard(), deps.logger);
    return;
  }
  const keyboard = new InlineKeyboard().text(smallCaps("❌ CANCEL"), "admin:flow:cancel");
  const sent = await replyRichOrLegacy(ctx, richHtmlMessage(prompt, keyboard), prompt, {
    fallbackKeyboard: keyboard,
    logger: deps.logger,
  });
  ctx.session.adminPanelChatId = sent.chat.id;
  ctx.session.adminPanelMessageId = sent.message_id;
}

async function showFlowPanel(ctx: BotContext, deps: BotDependencies, text: string, keyboard?: InlineKeyboard): Promise<void> {
  const chatId = ctx.session.adminPanelChatId ?? ctx.chat?.id;
  const messageId = ctx.session.adminPanelMessageId;
  if (chatId !== undefined && messageId !== undefined) {
    await editMessageRichOrLegacy(ctx, chatId, messageId, richHtmlMessage(text, keyboard), text, {
      ...(keyboard ? { fallbackKeyboard: keyboard } : {}),
      logger: deps.logger,
    });
    return;
  }
  await replyRichOrLegacy(ctx, richHtmlMessage(text, keyboard), text, {
    ...(keyboard ? { fallbackKeyboard: keyboard } : {}),
    logger: deps.logger,
  });
}

async function replyNotice(ctx: BotContext, deps: BotDependencies, title: string, body: string): Promise<void> {
  const fallbackText = `${escapeHtml(smallCaps(title))}\n\n${escapeHtml(smallCaps(body))}`;
  await replyRichOrLegacy(ctx, {
    blocks: [richHeading(title, 1), richParagraph(body, true)],
  }, fallbackText, { logger: deps.logger });
}

function cancelFlowKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text(smallCaps("❌ Cancel"), "admin:flow:cancel");
}

function allowsSkip(flow: AdminFlow): boolean {
  return flow.kind === "category:edit:description" ||
    flow.kind === "product:create:description" || flow.kind === "product:create:emoji" ||
    flow.kind === "product:edit:description" || flow.kind === "product:edit:emoji" ||
    flow.kind === "product:edit:planDetails" || flow.kind === "product:edit:instructions" ||
    flow.kind === "product:edit:media" || flow.kind === "product:edit:image";
}

function parseWholeNumber(raw: string, label: string, min = 0, max = 1_000_000_000): number {
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ValidationError(`${label} must be a whole number from ${min.toLocaleString()} to ${max.toLocaleString()}.`);
  }
  return value;
}

async function completeOrShowError(
  ctx: BotContext,
  deps: BotDependencies,
  action: () => Promise<void>,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (error instanceof DomainError || error instanceof ValidationError) {
      await showFlowPanel(ctx, deps, `⚠️ ${escapeHtml(smallCaps(error.message))}\n\n${smallCaps("Try again, or cancel this form.")}`, cancelFlowKeyboard());
      return;
    }
    deps.logger.error({ err: error, ownerId: deps.config.ownerId.toString() }, "Admin workflow failed");
    await showFlowPanel(ctx, deps, smallCaps("⚠️ I couldn't complete that step. Check the application logs, then try again or cancel."), cancelFlowKeyboard());
  }
}

export function registerAdminFlow(bot: Bot<BotContext>, deps: BotDependencies): void {
  bot.on("message:photo", async (ctx, next) => {
    const flow = ctx.session.adminFlow;
    if (!flow || flow.kind !== "product:edit:media") return next();
    if (!(await requirePrivate(ctx))) return;
    if (!isOwner(ctx, deps.config)) {
      ctx.session.adminFlow = null;
      await replyNotice(ctx, deps, "⛔ Owner workflow", "This owner workflow is private.");
      return;
    }
    const largestPhoto = ctx.message.photo.at(-1);
    if (!largestPhoto) {
      await replyNotice(ctx, deps, "⚠️ Photo not received", "Could not read that photo. Please try again.");
      return;
    }
    await updateProduct(deps.database.prisma, flow.productId, { mediaFileId: largestPhoto.file_id });
    ctx.session.adminFlow = null;
    await showProductAdmin(ctx, deps, flow.productId);
  });

  bot.on("message:text", async (ctx, next) => {
    const userFlow = ctx.session.userFlow;
    const flow = ctx.session.adminFlow;
    if (!flow && userFlow) {
      if (!(await requirePrivate(ctx))) return;
      const text = ctx.message.text.trim();
      if (text.startsWith("/")) return next();
      try {
        if (userFlow.kind === "store:search") {
          ctx.session.userFlow = null;
          await showStoreSearchResults(ctx, deps, text);
          return;
        }
        if (userFlow.kind === "warranty:reason") {
          await handleUserWarrantySubmission(ctx, deps, userFlow.purchaseId, text);
          return;
        }
      } catch (error) {
        if (error instanceof DomainError || error instanceof ValidationError) {
          await replyNotice(ctx, deps, "⚠️ Request needs attention", error.message);
          return;
        }
        throw error;
      }
    }

    if (!flow) return next();
    if (!(await requirePrivate(ctx))) return;
    if (!isOwner(ctx, deps.config)) {
      ctx.session.adminFlow = null;
      await replyNotice(ctx, deps, "⛔ Owner workflow", "This owner workflow is private.");
      return;
    }
    const text = ctx.message.text.trim();
    if (text.startsWith("/") && text !== "/skip") return next();
    if (text === "/skip" && !allowsSkip(flow)) {
      await showFlowPanel(
        ctx,
        deps,
        smallCaps("⚠️ This step is required. Send a value, or use /cancel to stop the form."),
        cancelFlowKeyboard(),
      );
      return;
    }

    await completeOrShowError(ctx, deps, async () => {
      switch (flow.kind) {
        case "category:create:name": {
          const category = await createCategory(deps.database.prisma, { name: text });
          ctx.session.adminFlow = null;
          await showFlowPanel(
            ctx,
            deps,
            `✅ ${smallCaps("Category created.")}\n\n${escapeHtml(category.emoji)} <b>${escapeHtml(category.name)}</b> ${smallCaps("is ready to manage.")}`,
            categoryDetailKeyboard(category),
          );
          break;
        }
        case "category:edit:name": {
          const category = await updateCategory(deps.database.prisma, flow.categoryId, { name: text });
          ctx.session.adminFlow = null;
          await showFlowPanel(ctx, deps, `✅ ${smallCaps("Category renamed to")} <b>${escapeHtml(category.name)}</b>.`, categoryDetailKeyboard(category));
          break;
        }
        case "category:edit:description": {
          const category = await updateCategory(deps.database.prisma, flow.categoryId, { description: text === "/skip" ? "" : text });
          ctx.session.adminFlow = null;
          await showFlowPanel(ctx, deps, `✅ ${smallCaps("Description updated for")} <b>${escapeHtml(category.name)}</b>.`, categoryDetailKeyboard(category));
          break;
        }
        case "category:edit:emoji": {
          const category = await updateCategory(deps.database.prisma, flow.categoryId, { emoji: text });
          ctx.session.adminFlow = null;
          await showFlowPanel(ctx, deps, `✅ ${smallCaps("Icon updated for")} <b>${escapeHtml(category.name)}</b>.`, categoryDetailKeyboard(category));
          break;
        }
        case "product:create:name": {
          if (text.length < 2 || text.length > 120) throw new ValidationError("Product names must be 2–120 characters.");
          ctx.session.adminFlow = { kind: "product:create:description", categoryId: flow.categoryId, name: text };
          await showFlowPanel(ctx, deps, `📝 ${smallCaps("Send a short product description for")} <b>${escapeHtml(text)}</b>. ${smallCaps("Send")} <code>/skip</code> ${smallCaps("to leave it blank.")}`);
          break;
        }
        case "product:create:description": {
          const description = text === "/skip" ? "" : text;
          if (description.length > 2_000) throw new ValidationError("Product descriptions are limited to 2,000 characters.");
          ctx.session.adminFlow = { kind: "product:create:price", categoryId: flow.categoryId, name: flow.name, description };
          await showFlowPanel(ctx, deps, `💳 ${smallCaps("Enter the price in whole credits for")} <b>${escapeHtml(flow.name)}</b> (0–1,000,000,000).`);
          break;
        }
        case "product:create:price": {
          const price = parseWholeNumber(text, "Price");
          ctx.session.adminFlow = { kind: "product:create:emoji", categoryId: flow.categoryId, name: flow.name, description: flow.description, price };
          await showFlowPanel(ctx, deps, `🎨 ${smallCaps("Send one emoji/icon for")} <b>${escapeHtml(flow.name)}</b>, ${smallCaps("or send")} <code>/skip</code> ${smallCaps("for ✦.")}`);
          break;
        }
        case "product:create:emoji": {
          const product = await createProduct(deps.database.prisma, {
            categoryId: flow.categoryId,
            name: flow.name,
            description: flow.description,
            price: flow.price,
            emoji: text === "/skip" ? "✦" : text,
          });
          ctx.session.adminFlow = null;
          await showProductAdmin(ctx, deps, product.id);
          break;
        }
        case "product:edit:name": {
          await updateProduct(deps.database.prisma, flow.productId, { name: text });
          ctx.session.adminFlow = null;
          await showProductAdmin(ctx, deps, flow.productId);
          break;
        }
        case "product:edit:description": {
          await updateProduct(deps.database.prisma, flow.productId, { description: text === "/skip" ? "" : text });
          ctx.session.adminFlow = null;
          await showProductAdmin(ctx, deps, flow.productId);
          break;
        }
        case "product:edit:planDetails": {
          await updateProduct(deps.database.prisma, flow.productId, { planDetails: text === "/skip" ? "" : text });
          ctx.session.adminFlow = null;
          await showProductAdmin(ctx, deps, flow.productId);
          break;
        }
        case "product:edit:instructions": {
          await updateProduct(deps.database.prisma, flow.productId, { deliveryInstructions: text === "/skip" ? "" : text });
          ctx.session.adminFlow = null;
          await showProductAdmin(ctx, deps, flow.productId);
          break;
        }
        case "product:edit:warranty": {
          await updateProduct(deps.database.prisma, flow.productId, { warrantyHours: parseWholeNumber(text, "Warranty hours", 0, 8_760) });
          ctx.session.adminFlow = null;
          await showProductAdmin(ctx, deps, flow.productId);
          break;
        }
        case "product:edit:media": {
          if (text === "/skip") {
            await updateProduct(deps.database.prisma, flow.productId, { mediaFileId: null });
            ctx.session.adminFlow = null;
            await showProductAdmin(ctx, deps, flow.productId);
          } else {
            throw new ValidationError("Please upload a photo, or send /skip to clear the banner photo.");
          }
          break;
        }
        case "product:edit:image": {
          await updateProduct(deps.database.prisma, flow.productId, { imageUrl: text === "/skip" ? null : text });
          ctx.session.adminFlow = null;
          await showProductAdmin(ctx, deps, flow.productId);
          break;
        }
        case "product:edit:price": {
          await updateProduct(deps.database.prisma, flow.productId, { price: parseWholeNumber(text, "Price") });
          ctx.session.adminFlow = null;
          await showProductAdmin(ctx, deps, flow.productId);
          break;
        }
        case "product:edit:emoji": {
          await updateProduct(deps.database.prisma, flow.productId, { emoji: text === "/skip" ? "✦" : text });
          ctx.session.adminFlow = null;
          await showProductAdmin(ctx, deps, flow.productId);
          break;
        }
        case "inventory:add:payload": {
          const payloads = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
          const result = await addInventoryItems(deps.database.prisma, flow.productId, payloads);
          ctx.session.adminFlow = null;
          const notified = result.inserted > 0
            ? await notifyRestockSubscribers(ctx, deps, flow.productId)
            : 0;
          const product = await getProduct(deps.database.prisma, flow.productId);
          const keyboard = productDetailKeyboard(product);
          if (result.inserted > 0) {
            keyboard.row().text(smallCaps("📢 ANNOUNCE RESTOCK TO ALL"), `admin:stock:announce:${product.id}`);
          }
          await showFlowPanel(
            ctx,
            deps,
            `✅ ${smallCaps("Imported")} <b>${result.inserted}</b> ${smallCaps("item(s) for")} ${escapeHtml(product.emoji)} <b>${escapeHtml(product.name)}</b>. ${smallCaps("Duplicate lines skipped:")} ${result.duplicates}.` +
              (notified > 0 ? `\n🔔 ${smallCaps("Auto-notified")} <b>${notified}</b> ${smallCaps("waiting subscriber(s)!")}` : "") +
              `\n\n${smallCaps("Inventory values are stored privately and delivered with parsed account details after purchase.")}`,
            keyboard,
          );
          break;
        }
        case "settings:bonus": {
          const parts = text.split(/\s+/).filter(Boolean);
          if (parts.length !== 2) throw new ValidationError("Send exactly two numbers: credits and cooldown hours.");
          const credits = parseWholeNumber(parts[0] ?? "", "Bonus credits", 1, 1_000_000);
          const periodHours = parseWholeNumber(parts[1] ?? "", "Cooldown hours", 1, 720);
          await updateBonusSettings(deps.database.prisma, { credits, periodHours });
          ctx.session.adminFlow = null;
          await showFlowPanel(ctx, deps, `✅ ${smallCaps("Daily bonus updated:")} <b>${credits} ${smallCaps("credits")}</b> ${smallCaps("every")} <b>${periodHours} ${smallCaps("hours")}</b>.`, new InlineKeyboard().text(smallCaps("⚙️ SETTINGS"), "admin:settings").text(smallCaps("◀ ADMIN"), "admin:panel"));
          break;
        }
        case "settings:referral": {
          const parts = text.split(/\s+/).filter(Boolean);
          if (parts.length !== 2) {
            throw new ValidationError("Send two whole numbers: referrer credits and friend welcome bonus (for example: 10 5).");
          }
          const referrerCredits = parseWholeNumber(parts[0] ?? "", "Referrer reward credits", 0, 1_000_000);
          const inviteeCredits = parseWholeNumber(parts[1] ?? "", "Friend welcome bonus", 0, 1_000_000);
          await updateReferralSettings(deps.database.prisma, { referrerCredits, inviteeCredits });
          ctx.session.adminFlow = null;
          await showFlowPanel(
            ctx,
            deps,
            `✅ ${smallCaps("Referral rewards updated:")} <b>+${referrerCredits} ${smallCaps("credits")}</b> ${smallCaps("to referrer")} · <b>+${inviteeCredits} ${smallCaps("credits")}</b> ${smallCaps("friend welcome bonus")}.`,
            new InlineKeyboard().text(smallCaps("⚙️ SETTINGS"), "admin:settings").text(smallCaps("◀ ADMIN"), "admin:panel"),
          );
          break;
        }
        case "broadcast:message": {
          if (!text || text.length > 3_500) throw new ValidationError("Broadcast text must be 1–3,500 characters.");
          ctx.session.adminFlow = { kind: "broadcast:confirm", text };
          await showFlowPanel(
            ctx,
            deps,
            `📢 <b>${smallCaps("Review broadcast")}</b>\n\n${escapeHtml(text)}`,
            new InlineKeyboard().text(smallCaps("📢 SEND TO USERS"), "admin:broadcast:send").text(smallCaps("❌ CANCEL"), "admin:broadcast:cancel"),
          );
          break;
        }
        case "broadcast:confirm": {
          await showFlowPanel(
            ctx,
            deps,
            `📢 <b>${smallCaps("Current broadcast preview")}</b>\n\n${escapeHtml(flow.text)}\n\n${smallCaps("Use the buttons to send or cancel.")}`,
            new InlineKeyboard().text(smallCaps("📢 SEND TO USERS"), "admin:broadcast:send").text(smallCaps("❌ CANCEL"), "admin:broadcast:cancel"),
          );
          break;
        }
      }
    });
  });

  bot.on("message:document", async (ctx, next) => {
    const flow = ctx.session.adminFlow;
    if (!flow || flow.kind !== "inventory:add:payload") return next();
    if (!(await requirePrivate(ctx))) return;
    if (!isOwner(ctx, deps.config)) {
      ctx.session.adminFlow = null;
      await replyNotice(ctx, deps, "⛔ Owner workflow", "This owner workflow is private.");
      return;
    }
    const document = ctx.message.document;
    const fileName = document.file_name?.toLowerCase() ?? "";
    if ((!fileName.endsWith(".txt") && !fileName.endsWith(".csv")) || (document.file_size ?? 0) > 1_000_000) {
      await replyNotice(ctx, deps, "📤 Inventory file required", "Upload a .txt or .csv file no larger than 1 MB, with one authorized item per line.");
      return;
    }
    try {
      const file = await ctx.getFile();
      if (!file.file_path) throw new Error("Telegram did not provide a download path for that file.");
      const url = new URL(file.file_path, `https://api.telegram.org/file/bot${deps.config.botToken}/`);
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`Telegram file download failed (${response.status}).`);
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Telegram returned an empty file stream.");
      const chunks: Uint8Array[] = [];
      let receivedBytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        receivedBytes += value.byteLength;
        if (receivedBytes > 1_000_000) {
          await reader.cancel();
          throw new Error("The inventory file exceeded 1 MB after download.");
        }
        chunks.push(value);
      }
      const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
      const payloads = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const result = await addInventoryItems(deps.database.prisma, flow.productId, payloads);
      ctx.session.adminFlow = null;
      const notified = result.inserted > 0
        ? await notifyRestockSubscribers(ctx, deps, flow.productId)
        : 0;
      await showProductAdmin(ctx, deps, flow.productId);
      const importSummary = `✅ Imported ${result.inserted} item(s). Duplicate lines skipped: ${result.duplicates}.` +
        (notified > 0 ? ` 🔔 Auto-notified ${notified} waiting subscriber(s)!` : "");
      await replyRichOrLegacy(ctx, {
        blocks: [
          richHeading("✅ Inventory import complete", 1),
          richKeyValueTable([
            ["Items imported", result.inserted.toLocaleString("en-US")],
            ["Duplicate lines skipped", result.duplicates.toLocaleString("en-US")],
            ["Subscribers notified", notified.toLocaleString("en-US")],
          ], "Import summary"),
        ],
      }, importSummary, { logger: deps.logger });
    } catch (error) {
      const detail = error instanceof Error
        ? error.message.replaceAll(deps.config.botToken, "[REDACTED]")
        : "Unknown upload error";
      deps.logger.warn({ error: detail }, "Bulk inventory upload failed");
      await replyNotice(ctx, deps, "⚠️ Import not completed", error instanceof DomainError ? error.message : "Couldn't import that file. Check the format and try again.");
    }
  });
}
