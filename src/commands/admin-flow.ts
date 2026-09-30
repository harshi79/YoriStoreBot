import { GrammyError, InlineKeyboard } from "grammy";
import type { Bot } from "grammy";
import type { BotContext } from "../types/context.js";
import type { AdminFlow } from "../types/session.js";
import type { BotDependencies } from "../bot/dependencies.js";
import { isOwner, requirePrivate } from "../bot/authorization.js";
import { categoryDetailKeyboard, productDetailKeyboard } from "../keyboards/inline.js";
import { getProduct, createCategory, createProduct, updateCategory, updateProduct, addInventoryItems } from "../services/store.service.js";
import { updateBonusSettings } from "../services/settings.service.js";
import { showProductAdmin } from "../bot/admin-views.js";
import { escapeHtml, smallCaps } from "../utils/format.js";
import { DomainError, ValidationError } from "../utils/errors.js";
import { editOrReply, isUnchangedEdit } from "../bot/render.js";

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
    await editOrReply(ctx, prompt, new InlineKeyboard().text("❌ CANCEL", "admin:flow:cancel"), deps.logger);
    return;
  }
  const sent = await ctx.reply(prompt, {
    parse_mode: "HTML",
    reply_markup: new InlineKeyboard().text("❌ CANCEL", "admin:flow:cancel"),
  });
  ctx.session.adminPanelChatId = sent.chat.id;
  ctx.session.adminPanelMessageId = sent.message_id;
}

async function showFlowPanel(ctx: BotContext, deps: BotDependencies, text: string, keyboard?: InlineKeyboard): Promise<void> {
  const chatId = ctx.session.adminPanelChatId ?? ctx.chat?.id;
  const messageId = ctx.session.adminPanelMessageId;
  if (chatId !== undefined && messageId !== undefined) {
    try {
      await ctx.api.editMessageText(chatId, messageId, text, {
        parse_mode: "HTML",
        ...(keyboard ? { reply_markup: keyboard } : {}),
        link_preview_options: { is_disabled: true },
      });
      return;
    } catch (error) {
      if (isUnchangedEdit(error)) return;
      if (!(error instanceof GrammyError)) throw error;
      deps.logger.debug({ err: error }, "Admin form message was no longer editable");
    }
  }
  await ctx.reply(text, { parse_mode: "HTML", ...(keyboard ? { reply_markup: keyboard } : {}) });
}

function allowsSkip(flow: AdminFlow): boolean {
  return flow.kind === "category:edit:description" ||
    flow.kind === "product:create:description" || flow.kind === "product:create:emoji" ||
    flow.kind === "product:edit:description" || flow.kind === "product:edit:emoji";
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
      await showFlowPanel(ctx, deps, `⚠️ ${escapeHtml(error.message)}\n\n${smallCaps("Try again, or cancel this form.")}`, new InlineKeyboard().text("❌ CANCEL", "admin:flow:cancel"));
      return;
    }
    deps.logger.error({ err: error, ownerId: deps.config.ownerId.toString() }, "Admin workflow failed");
    await showFlowPanel(ctx, deps, "⚠️ I couldn't complete that step. Check the application logs, then try again or cancel.", new InlineKeyboard().text("❌ CANCEL", "admin:flow:cancel"));
  }
}

export function registerAdminFlow(bot: Bot<BotContext>, deps: BotDependencies): void {
  bot.on("message:text", async (ctx, next) => {
    const flow = ctx.session.adminFlow;
    if (!flow) return next();
    if (!(await requirePrivate(ctx))) return;
    if (!isOwner(ctx, deps.config)) {
      ctx.session.adminFlow = null;
      await ctx.reply("⛔ This owner workflow is private.");
      return;
    }
    const text = ctx.message.text.trim();
    if (text.startsWith("/") && text !== "/skip") return next();
    if (text === "/skip" && !allowsSkip(flow)) {
      await showFlowPanel(
        ctx,
        deps,
        "⚠️ This step is required. Send a value, or use /cancel to stop the form.",
        new InlineKeyboard().text("❌ CANCEL", "admin:flow:cancel"),
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
            `✅ Category created.\n\n${escapeHtml(category.emoji)} <b>${escapeHtml(category.name)}</b> is ready to manage.`,
            categoryDetailKeyboard(category),
          );
          break;
        }
        case "category:edit:name": {
          const category = await updateCategory(deps.database.prisma, flow.categoryId, { name: text });
          ctx.session.adminFlow = null;
          await showFlowPanel(ctx, deps, `✅ Category renamed to <b>${escapeHtml(category.name)}</b>.`, categoryDetailKeyboard(category));
          break;
        }
        case "category:edit:description": {
          const category = await updateCategory(deps.database.prisma, flow.categoryId, { description: text === "/skip" ? "" : text });
          ctx.session.adminFlow = null;
          await showFlowPanel(ctx, deps, `✅ Description updated for <b>${escapeHtml(category.name)}</b>.`, categoryDetailKeyboard(category));
          break;
        }
        case "category:edit:emoji": {
          const category = await updateCategory(deps.database.prisma, flow.categoryId, { emoji: text });
          ctx.session.adminFlow = null;
          await showFlowPanel(ctx, deps, `✅ Icon updated for <b>${escapeHtml(category.name)}</b>.`, categoryDetailKeyboard(category));
          break;
        }
        case "product:create:name": {
          if (text.length < 2 || text.length > 120) throw new ValidationError("Product names must be 2–120 characters.");
          ctx.session.adminFlow = { kind: "product:create:description", categoryId: flow.categoryId, name: text };
          await showFlowPanel(ctx, deps, `📝 Send a short product description for <b>${escapeHtml(text)}</b>. Send <code>/skip</code> to leave it blank.`);
          break;
        }
        case "product:create:description": {
          const description = text === "/skip" ? "" : text;
          if (description.length > 2_000) throw new ValidationError("Product descriptions are limited to 2,000 characters.");
          ctx.session.adminFlow = { kind: "product:create:price", categoryId: flow.categoryId, name: flow.name, description };
          await showFlowPanel(ctx, deps, `💳 Enter the price in whole credits for <b>${escapeHtml(flow.name)}</b> (0–1,000,000,000).`);
          break;
        }
        case "product:create:price": {
          const price = parseWholeNumber(text, "Price");
          ctx.session.adminFlow = { kind: "product:create:emoji", categoryId: flow.categoryId, name: flow.name, description: flow.description, price };
          await showFlowPanel(ctx, deps, `🎨 Send one emoji/icon for <b>${escapeHtml(flow.name)}</b>, or send <code>/skip</code> for ✦.`);
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
          const product = await getProduct(deps.database.prisma, flow.productId);
          await showFlowPanel(
            ctx,
            deps,
            `✅ Imported <b>${result.inserted}</b> item(s) for ${escapeHtml(product.emoji)} <b>${escapeHtml(product.name)}</b>. Duplicate lines skipped: ${result.duplicates}.\n\n${smallCaps("Inventory values are stored privately and delivered only after purchase.")}`,
            productDetailKeyboard(product),
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
          await showFlowPanel(ctx, deps, `✅ Daily bonus updated: <b>${credits} credits</b> every <b>${periodHours} hours</b>.`, new InlineKeyboard().text("⚙️ SETTINGS", "admin:settings").text("◀ ADMIN", "admin:panel"));
          break;
        }
        case "broadcast:message": {
          if (!text || text.length > 3_500) throw new ValidationError("Broadcast text must be 1–3,500 characters.");
          ctx.session.adminFlow = { kind: "broadcast:confirm", text };
          await showFlowPanel(
            ctx,
            deps,
            `📢 <b>Review broadcast</b>\n\n${escapeHtml(text)}`,
            new InlineKeyboard().text("📢 SEND TO USERS", "admin:broadcast:send").text("❌ CANCEL", "admin:broadcast:cancel"),
          );
          break;
        }
        case "broadcast:confirm": {
          await showFlowPanel(
            ctx,
            deps,
            `📢 <b>Current broadcast preview</b>\n\n${escapeHtml(flow.text)}\n\n${smallCaps("Use the buttons to send or cancel.")}`,
            new InlineKeyboard().text("📢 SEND TO USERS", "admin:broadcast:send").text("❌ CANCEL", "admin:broadcast:cancel"),
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
      await ctx.reply("⛔ This owner workflow is private.");
      return;
    }
    const document = ctx.message.document;
    const fileName = document.file_name?.toLowerCase() ?? "";
    if ((!fileName.endsWith(".txt") && !fileName.endsWith(".csv")) || (document.file_size ?? 0) > 1_000_000) {
      await ctx.reply("Please upload a .txt or .csv file no larger than 1 MB, with one authorized item per line.");
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
      await showProductAdmin(ctx, deps, flow.productId);
      await ctx.reply(`✅ Imported ${result.inserted} item(s). Duplicate lines skipped: ${result.duplicates}.`);
    } catch (error) {
      const detail = error instanceof Error
        ? error.message.replaceAll(deps.config.botToken, "[REDACTED]")
        : "Unknown upload error";
      deps.logger.warn({ error: detail }, "Bulk inventory upload failed");
      await ctx.reply(error instanceof DomainError ? error.message : "Couldn't import that file. Check the format and try again.");
    }
  });
}
