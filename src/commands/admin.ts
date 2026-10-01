import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { InputFile, InlineKeyboard } from "grammy";
import type { Bot } from "grammy";
import type { BotContext } from "../types/context.js";
import type { BotDependencies } from "../bot/dependencies.js";
import { requireOwner, requirePrivate } from "../bot/authorization.js";
import { adminPanelKeyboard } from "../keyboards/inline.js";
import { editOrReply, editOrReplyRich, replyRichOrLegacy, sendRichOrLegacy } from "../bot/render.js";
import { showAdminPanel, showInventoryAdmin, showStatistics } from "../bot/admin-views.js";
import { createRedeemCodes } from "../services/codes.service.js";
import { giftAllActiveUsers, giftCredits, removeCredits } from "../services/credits.service.js";
import { getResetPreview, createResetChallenge, advanceResetChallenge, performConfirmedReset, cancelResetChallenge } from "../services/admin.service.js";
import { buildStoreExport } from "../services/export.service.js";
import { escapeHtml, formatDate, smallCaps, creditLabel } from "../utils/format.js";
import {
  richButtonRow,
  richCallbackButton,
  richDataTable,
  richFooter,
  richHeading,
  richKeyValueTable,
  richParagraph,
} from "../messages/rich-ui.js";
import { DomainError } from "../utils/errors.js";
import type { ResetPreview } from "../services/admin.service.js";

const execFileAsync = promisify(execFile);

function parseCommandArgs(text: string, expected: number, usage: string): string[] {
  const args = text.trim().split(/\s+/).filter(Boolean);
  if (args.length !== expected) throw new DomainError(`Use: ${usage}`, "VALIDATION");
  return args;
}

function parseTelegramUserId(value: string): bigint {
  if (!/^[1-9]\d{0,15}$/.test(value)) {
    throw new DomainError("User ID must be a positive Telegram user ID.", "VALIDATION");
  }
  const telegramId = BigInt(value);
  if (telegramId > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new DomainError("User ID is outside Telegram's supported range.", "VALIDATION");
  }
  return telegramId;
}

function parseCredits(value: string): number {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 2_000_000_000) {
    throw new DomainError("Credits must be a positive whole number within the balance limit.", "VALIDATION");
  }
  return amount;
}

async function reportAdminCommandError(
  ctx: BotContext,
  deps: BotDependencies,
  command: string,
  error: unknown,
): Promise<void> {
  if (error instanceof DomainError) {
    await replyRichOrLegacy(ctx, {
      blocks: [richHeading("⚠️ Command needs attention", 1), richParagraph(error.message)],
    }, `⚠️ ${escapeHtml(error.message)}`, { logger: deps.logger });
    return;
  }
  deps.logger.error({ err: error, command }, "Owner command failed");
  const fallback = "⚠️ Iris couldn't complete that command. Please try again or check the application logs.";
  await replyRichOrLegacy(ctx, {
    blocks: [
      richHeading("⚠️ Command not completed", 1),
      richParagraph("Try again or check the application logs.", true),
    ],
  }, fallback, { logger: deps.logger });
}

function resetSummary(preview: ResetPreview): string {
  return `• ${smallCaps("User profiles")}: ${preview.users}\n` +
    `• ${smallCaps("Categories")}: ${preview.categories}\n` +
    `• ${smallCaps("Products")}: ${preview.products}\n` +
    `• ${smallCaps("Inventory items")}: ${preview.inventory}\n` +
    `• ${smallCaps("Purchases")}: ${preview.purchases}\n` +
    `• ${smallCaps("Redeem codes")}: ${preview.redeemCodes}\n` +
    `• ${smallCaps("Code redemptions")}: ${preview.redemptions}\n` +
    `• ${smallCaps("Credit ledger entries")}: ${preview.creditTransactions}`;
}

async function exportFile(prisma: BotDependencies["database"]["prisma"]): Promise<{ buffer: Buffer; filename: string }> {
  const data = await buildStoreExport(prisma);
  const json = Buffer.from(JSON.stringify(data, null, 2), "utf8");
  if (json.byteLength <= 40 * 1024 * 1024) return { buffer: json, filename: `iris-store-${Date.now()}.json` };
  return { buffer: gzipSync(json), filename: `iris-store-${Date.now()}.json.gz` };
}

export async function sendStoreExport(ctx: BotContext, deps: BotDependencies, caption = "✦ Iris store export · contains private inventory payloads; keep it secure."): Promise<void> {
  const { buffer, filename } = await exportFile(deps.database.prisma);
  if (buffer.byteLength > 49 * 1024 * 1024) {
    throw new Error("The export is too large for Telegram. Use PostgreSQL backups for this store.");
  }
  const fileCaption = smallCaps(caption);
  try {
    await ctx.replyWithRichMessage({
      blocks: [
        richHeading("📤 Iris store export", 1),
        richParagraph("This file contains store records and private inventory payloads. Keep it secure.", true),
        {
          type: "document",
          document: { type: "document", media: new InputFile(buffer, filename) },
          caption: { text: fileCaption },
        },
      ],
    });
  } catch (error) {
    deps.logger.debug({ err: error }, "Rich store export failed; using a standard document message");
    await ctx.replyWithDocument(new InputFile(buffer, filename), { caption: fileCaption });
  }
}

export async function beginReset(ctx: BotContext, deps: BotDependencies): Promise<void> {
  const preview = await getResetPreview(deps.database.prisma);
  try {
    await sendStoreExport(ctx, deps, "⚠️ Pre-reset backup. This file contains all shop inventory payloads; store it safely.");
  } catch (error) {
    deps.logger.error({ err: error }, "Could not create the required pre-reset backup");
    const fallback = "I couldn't deliver a backup, so reset has not been armed. Use /export or check the database/export size.";
    await replyRichOrLegacy(ctx, {
      blocks: [richHeading("⚠️ Reset not armed", 1), richParagraph("A backup could not be delivered. Use /export or check the database/export size.", true)],
    }, fallback, { logger: deps.logger });
    return;
  }
  const challenge = await createResetChallenge(deps.database.prisma, deps.config.ownerId);
  const keyboard = new InlineKeyboard()
    .text(smallCaps("⚠️ Continue"), `reset:continue:${challenge.id}:${challenge.token}`)
    .text(smallCaps("❌ Cancel"), `reset:cancel:${challenge.id}`);
  const fallback = `⚠️ <b>${smallCaps("Dangerous operation")}</b>\n\n` +
    `${smallCaps("This will permanently delete the following store data:")}\n${resetSummary(preview)}\n\n` +
    `<b>${smallCaps("Preserved")}:</b> ${smallCaps("Runtime settings and admin audit history")}\n` +
    `<b>${smallCaps("Backup")}:</b> ${smallCaps("Sent above. Confirmation expires")} ${escapeHtml(formatDate(challenge.expiresAt))}.\n\n` +
    `${smallCaps("No data has been deleted. Continue only if you understand the scope.")}`;
  await replyRichOrLegacy(ctx, {
    blocks: [
      richHeading("⚠️ Dangerous operation", 1),
      richParagraph("This will permanently delete the following store data.", true),
      richDataTable(["Data set", "Records"], [
        ["User profiles", preview.users.toLocaleString("en-US")],
        ["Categories", preview.categories.toLocaleString("en-US")],
        ["Products", preview.products.toLocaleString("en-US")],
        ["Inventory items", preview.inventory.toLocaleString("en-US")],
        ["Purchases", preview.purchases.toLocaleString("en-US")],
        ["Redeem codes", preview.redeemCodes.toLocaleString("en-US")],
        ["Code redemptions", preview.redemptions.toLocaleString("en-US")],
        ["Credit ledger entries", preview.creditTransactions.toLocaleString("en-US")],
      ], "Reset scope", ["left", "right"]),
      richKeyValueTable([
        ["Runtime settings", smallCaps("Preserved")],
        ["Admin audit history", smallCaps("Preserved")],
        ["Backup expires", formatDate(challenge.expiresAt)],
      ], "Safety checks"),
      richParagraph("No data has been deleted. Continue only if you understand the scope.", true),
      richButtonRow([
        richCallbackButton("⚠️ Continue", `reset:continue:${challenge.id}:${challenge.token}`, "danger"),
        richCallbackButton("❌ Cancel", `reset:cancel:${challenge.id}`, "link"),
      ]),
    ],
  }, fallback, { fallbackKeyboard: keyboard, logger: deps.logger });
}

export async function continueReset(
  ctx: BotContext,
  deps: BotDependencies,
  challengeId: string,
  token: string,
): Promise<void> {
  await advanceResetChallenge(deps.database.prisma, challengeId, token, deps.config.ownerId);
  const preview = await getResetPreview(deps.database.prisma);
  try {
    await sendStoreExport(ctx, deps, "⚠️ Final fresh backup immediately before the second reset confirmation.");
  } catch (error) {
    deps.logger.error({ err: error }, "Could not deliver the final reset backup");
    await editOrReply(ctx, smallCaps("Backup delivery failed. Reset was not executed; let this confirmation expire and use /reset again."), adminPanelKeyboard(), deps.logger);
    return;
  }
  const keyboard = new InlineKeyboard()
    .text(smallCaps("⚠️ Delete everything"), `reset:delete:${challengeId}:${token}`)
    .text(smallCaps("❌ Cancel"), `reset:cancel:${challengeId}`);
  const fallback = `⚠️ <b>${smallCaps("Final confirmation")}</b>\n\n` +
    `${smallCaps("The fresh backup was sent above. The following will be deleted:")}\n${resetSummary(preview)}\n\n` +
    `${smallCaps("Settings and admin audit history are preserved. This confirmation is one-time and expires shortly.")}`;
  await editOrReplyRich(ctx, {
    blocks: [
      richHeading("⚠️ Final confirmation", 1),
      richParagraph("The fresh backup was sent above. The following will be deleted.", true),
      richDataTable(["Data set", "Records"], [
        ["User profiles", preview.users.toLocaleString("en-US")],
        ["Categories", preview.categories.toLocaleString("en-US")],
        ["Products", preview.products.toLocaleString("en-US")],
        ["Inventory items", preview.inventory.toLocaleString("en-US")],
        ["Purchases", preview.purchases.toLocaleString("en-US")],
        ["Redeem codes", preview.redeemCodes.toLocaleString("en-US")],
        ["Code redemptions", preview.redemptions.toLocaleString("en-US")],
        ["Credit ledger entries", preview.creditTransactions.toLocaleString("en-US")],
      ], "Final reset scope", ["left", "right"]),
      richFooter("Runtime settings and admin audit history are preserved. This one-time confirmation expires shortly.", true),
      richButtonRow([
        richCallbackButton("⚠️ Delete everything", `reset:delete:${challengeId}:${token}`, "danger"),
        richCallbackButton("❌ Cancel", `reset:cancel:${challengeId}`, "link"),
      ]),
    ],
  }, fallback, { fallbackKeyboard: keyboard, logger: deps.logger });
}

export async function completeReset(
  ctx: BotContext,
  deps: BotDependencies,
  challengeId: string,
  token: string,
): Promise<void> {
  const deleted = await performConfirmedReset(deps.database.prisma, challengeId, token, deps.config.ownerId);
  deps.logger.warn({ ownerId: deps.config.ownerId.toString(), deleted }, "Owner completed a full store reset");
  const fallback = `✅ <b>${smallCaps("Reset complete")}</b>\n\n${smallCaps("Deleted")} ${deleted.users} ${smallCaps("user profile(s),")} ${deleted.products} ${smallCaps("product(s),")} ${deleted.inventory} ${smallCaps("inventory item(s), and all matching store records. Settings and reset audit history remain.")}`;
  await editOrReplyRich(ctx, {
    blocks: [
      richHeading("✅ Reset complete", 1),
      richDataTable(["Data set", "Deleted"], [
        ["User profiles", deleted.users.toLocaleString("en-US")],
        ["Products", deleted.products.toLocaleString("en-US")],
        ["Inventory items", deleted.inventory.toLocaleString("en-US")],
      ], "Reset result", ["left", "right"]),
      richParagraph("All matching store records were removed. Runtime settings and reset audit history remain.", true),
      richButtonRow([richCallbackButton("◀ Owner console", "admin:panel", "link")]),
    ],
  }, fallback, { fallbackKeyboard: adminPanelKeyboard(), logger: deps.logger });
}

export async function cancelReset(
  ctx: BotContext,
  deps: BotDependencies,
  challengeId: string,
): Promise<void> {
  await cancelResetChallenge(deps.database.prisma, challengeId, deps.config.ownerId);
  const fallback = `✅ ${smallCaps("Reset cancelled. Nothing was deleted.")}`;
  await editOrReplyRich(ctx, {
    blocks: [
      richHeading("✅ Reset cancelled", 1),
      richParagraph("Nothing was deleted.", true),
      richButtonRow([richCallbackButton("◀ Owner console", "admin:panel", "link")]),
    ],
  }, fallback, { fallbackKeyboard: adminPanelKeyboard(), logger: deps.logger });
}

export async function requestRestart(
  ctx: BotContext,
  bot: Bot<BotContext>,
  deps: BotDependencies,
): Promise<void> {
  const appName = deps.config.pm2AppName.trim();
  if (!appName || !process.env.PM2_HOME) {
    await editOrReply(
      ctx,
      `🔄 <b>${smallCaps("Restart unavailable")}</b>\n\n${smallCaps("No PM2 runtime is configured. Restart Iris from your host or process manager; it will keep running normally.")}`,
      adminPanelKeyboard(),
      deps.logger,
    );
    return;
  }
  try {
    const { stdout } = await execFileAsync("pm2", ["jlist"], { timeout: 5_000, maxBuffer: 2 * 1024 * 1024 });
    const processes = JSON.parse(stdout) as Array<{ name?: string }>;
    if (!processes.some((process) => process.name === appName)) {
      throw new Error("The configured PM2 app name was not found.");
    }
  } catch (error) {
    deps.logger.warn({ err: error, appName }, "PM2 restart could not be verified");
    await editOrReply(
      ctx,
      `🔄 <b>${smallCaps("Restart not started")}</b>\n\n${smallCaps("I could not verify the configured PM2 process. Iris is still running; restart it from your host.")}`,
      adminPanelKeyboard(),
      deps.logger,
    );
    return;
  }

  await editOrReply(ctx, `🔄 ${smallCaps("Requesting a graceful PM2 restart…")}`, adminPanelKeyboard(), deps.logger);
  execFile("pm2", ["restart", appName], { timeout: 30_000 }, (error) => {
    if (error) {
      deps.logger.error({ err: error, appName }, "PM2 restart command failed");
      void sendRichOrLegacy(ctx, Number(deps.config.ownerId), {
        blocks: [
          richHeading("⚠️ PM2 restart failed", 1),
          richParagraph("Iris may still be running; please restart it from the host.", true),
        ],
      }, "PM2 restart failed. Iris may still be running; please restart it from the host.", { logger: deps.logger })
        .catch((notifyError: unknown) => deps.logger.warn({ err: notifyError }, "Could not notify owner after PM2 restart failure"));
    } else {
      deps.logger.info({ appName }, "PM2 restart command accepted");
    }
  });
  // PM2 sends the normal shutdown signal after accepting the command; the process signal handler closes polling and PostgreSQL.
  void bot;
}

export function registerAdminCommands(bot: Bot<BotContext>, deps: BotDependencies): void {
  bot.command("admin", async (ctx) => {
    if (!(await requireOwner(ctx, deps.config))) return;
    if (!(await requirePrivate(ctx))) return;
    ctx.session.adminFlow = null;
    await showAdminPanel(ctx, deps);
  });

  bot.command("gift", async (ctx) => {
    if (!(await requireOwner(ctx, deps.config)) || !(await requirePrivate(ctx))) return;
    try {
      const [rawUserId, rawCredits] = parseCommandArgs(ctx.match, 2, "/gift <userid> <credits>");
      const credits = parseCredits(rawCredits!);
      const recipient = parseTelegramUserId(rawUserId!);
      const updated = await giftCredits(deps.database.prisma, recipient, credits);
      deps.logger.info({ ownerId: deps.config.ownerId.toString(), recipient: recipient.toString(), credits }, "Owner gifted credits");
      const fallback = `✅ ${smallCaps("Added")} ${credits} ${smallCaps("credits. New balance:")} ${updated.credits}.`;
      await replyRichOrLegacy(ctx, {
        blocks: [
          richHeading("✅ Credits added", 1),
          richKeyValueTable([
            ["Recipient ID", recipient.toString()],
            ["Credits added", creditLabel(credits)],
            ["New balance", creditLabel(updated.credits)],
          ], "Credit adjustment"),
        ],
      }, fallback, { logger: deps.logger });
    } catch (error) {
      await reportAdminCommandError(ctx, deps, "gift", error);
    }
  });

  bot.command("rm", async (ctx) => {
    if (!(await requireOwner(ctx, deps.config)) || !(await requirePrivate(ctx))) return;
    try {
      const [rawUserId, rawCredits] = parseCommandArgs(ctx.match, 2, "/rm <userid> <credits>");
      const credits = parseCredits(rawCredits!);
      const recipient = parseTelegramUserId(rawUserId!);
      const updated = await removeCredits(deps.database.prisma, recipient, credits);
      deps.logger.info({ ownerId: deps.config.ownerId.toString(), recipient: recipient.toString(), credits }, "Owner removed credits");
      const fallback = `✅ ${smallCaps("Removed")} ${credits} ${smallCaps("credits. New balance:")} ${updated.credits}.`;
      await replyRichOrLegacy(ctx, {
        blocks: [
          richHeading("✅ Credits removed", 1),
          richKeyValueTable([
            ["Recipient ID", recipient.toString()],
            ["Credits removed", creditLabel(credits)],
            ["New balance", creditLabel(updated.credits)],
          ], "Credit adjustment"),
        ],
      }, fallback, { logger: deps.logger });
    } catch (error) {
      await reportAdminCommandError(ctx, deps, "rm", error);
    }
  });

  bot.command("giftall", async (ctx) => {
    if (!(await requireOwner(ctx, deps.config)) || !(await requirePrivate(ctx))) return;
    try {
      const [rawCredits] = parseCommandArgs(ctx.match, 1, "/giftall <credits>");
      const credits = parseCredits(rawCredits!);
      const result = await giftAllActiveUsers(deps.database.prisma, credits, 72);
      deps.logger.info({ ownerId: deps.config.ownerId.toString(), ...result }, "Owner issued active-user credit gift");
      const fallback = `✅ ${smallCaps("Gifted")} ${credits} ${smallCaps("credits to")} ${result.recipients} ${smallCaps("users active within 72 hours. Skipped")} ${result.skipped} ${smallCaps("over-limit balance(s).")}`;
      await replyRichOrLegacy(ctx, {
        blocks: [
          richHeading("✅ Credit gift sent", 1),
          richKeyValueTable([
            ["Credits per user", creditLabel(credits)],
            ["Recipients", result.recipients.toLocaleString("en-US")],
            ["Skipped · balance limit", result.skipped.toLocaleString("en-US")],
            ["Activity window", smallCaps("72 hours")],
          ], "Gift delivery"),
        ],
      }, fallback, { logger: deps.logger });
    } catch (error) {
      await reportAdminCommandError(ctx, deps, "giftall", error);
    }
  });

  bot.command("code", async (ctx) => {
    if (!(await requireOwner(ctx, deps.config)) || !(await requirePrivate(ctx))) return;
    try {
      const [rawAmount, rawCredits, rawMax] = parseCommandArgs(ctx.match, 3, "/code <amount> <credits> <maxredeems>");
      const amount = parseCredits(rawAmount!);
      const credits = parseCredits(rawCredits!);
      const maxRedeems = parseCredits(rawMax!);
      if (amount > 100) throw new DomainError("Generate at most 100 codes in one batch.", "VALIDATION");
      const codes = await createRedeemCodes(deps.database.prisma, {
        amount,
        credits,
        maxRedeems,
        createdBy: deps.config.ownerId,
      });
      deps.logger.info({ ownerId: deps.config.ownerId.toString(), amount, credits, maxRedeems }, "Owner generated redeem codes");
      const fallback = `🔑 <b>${smallCaps("Credit codes created")}</b>\n` +
        `${codes.map((code) => `<code>${escapeHtml(code)}</code>`).join("\n")}\n\n` +
        `${smallCaps("Each code grants")} ${creditLabel(credits)} · ${maxRedeems} ${smallCaps("redemption(s) per code.")}`;
      await replyRichOrLegacy(ctx, {
        blocks: [
          richHeading("🔑 Credit codes created", 1),
          richParagraph("Use each code exactly as shown. Share them only with their intended recipients.", true),
          richDataTable(
            ["Code", "Credits per redemption", "Redemption limit"],
            codes.map((code) => [
              { type: "code", text: code },
              creditLabel(credits),
              maxRedeems.toLocaleString("en-US"),
            ]),
            "Generated codes",
            ["left", "right", "right"],
          ),
        ],
      }, fallback, { logger: deps.logger });
    } catch (error) {
      await reportAdminCommandError(ctx, deps, "code", error);
    }
  });

  bot.command("broadcast", async (ctx) => {
    if (!(await requireOwner(ctx, deps.config)) || !(await requirePrivate(ctx))) return;
    const text = ctx.match.trim();
    if (text.length > 3_500) {
      await replyRichOrLegacy(ctx, {
        blocks: [richHeading("⚠️ Broadcast is too long", 1), richParagraph("Broadcast text is limited to 3,500 characters.", true)],
      }, "⚠️ Broadcast text is limited to 3,500 characters.", { logger: deps.logger });
      return;
    }
    if (text) {
      ctx.session.adminFlow = { kind: "broadcast:confirm", text };
      const keyboard = new InlineKeyboard()
        .text(smallCaps("📢 Send to users"), "admin:broadcast:send")
        .text(smallCaps("❌ Cancel"), "admin:broadcast:cancel");
      const sent = await replyRichOrLegacy(ctx, {
        blocks: [
          richHeading("📢 Broadcast preview", 1),
          { type: "expandable_blockquote", text, credit: smallCaps("Broadcast text") },
          richFooter("This message will be delivered exactly as shown.", true),
          richButtonRow([
            richCallbackButton("📢 Send to users", "admin:broadcast:send", "success"),
            richCallbackButton("❌ Cancel", "admin:broadcast:cancel", "link"),
          ]),
        ],
      }, `📢 <b>${smallCaps("Broadcast preview")}</b>\n\n${escapeHtml(text)}`, {
        fallbackKeyboard: keyboard,
        logger: deps.logger,
      });
      ctx.session.adminPanelChatId = sent.chat.id;
      ctx.session.adminPanelMessageId = sent.message_id;
      return;
    }
    ctx.session.adminFlow = { kind: "broadcast:message" };
    const fallback = `${smallCaps("Send the plain-text broadcast now.")} ${smallCaps("Use /cancel to stop.")}`;
    const sent = await replyRichOrLegacy(ctx, {
      blocks: [
        richHeading("📢 New broadcast", 1),
        richParagraph("Send the exact plain-text message for customers. Use /cancel to stop.", true),
        richFooter("Messages cannot be recalled after delivery.", true),
      ],
    }, fallback, { logger: deps.logger });
    ctx.session.adminPanelChatId = sent.chat.id;
    ctx.session.adminPanelMessageId = sent.message_id;
  });

  bot.command("stats", async (ctx) => {
    if (!(await requireOwner(ctx, deps.config)) || !(await requirePrivate(ctx))) return;
    await showStatistics(ctx, deps);
  });

  bot.command("export", async (ctx) => {
    if (!(await requireOwner(ctx, deps.config)) || !(await requirePrivate(ctx))) return;
    try {
      await sendStoreExport(ctx, deps);
    } catch (error) {
      deps.logger.error({ err: error }, "Store export failed");
      await replyRichOrLegacy(ctx, {
        blocks: [richHeading("⚠️ Export not created", 1), richParagraph("Check the application logs or use a PostgreSQL backup.", true)],
      }, "I couldn't create the export. Check the application logs or use a PostgreSQL backup.", { logger: deps.logger });
    }
  });

  bot.command("addstock", async (ctx) => {
    if (!(await requireOwner(ctx, deps.config)) || !(await requirePrivate(ctx))) return;
    ctx.session.adminFlow = null;
    await showInventoryAdmin(ctx, deps);
  });

  bot.command("restart", async (ctx) => {
    if (!(await requireOwner(ctx, deps.config)) || !(await requirePrivate(ctx))) return;
    await requestRestart(ctx, bot, deps);
  });

  bot.command("reset", async (ctx) => {
    if (!(await requireOwner(ctx, deps.config)) || !(await requirePrivate(ctx))) return;
    await beginReset(ctx, deps);
  });
}
