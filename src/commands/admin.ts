import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { InputFile, InlineKeyboard } from "grammy";
import type { Bot } from "grammy";
import type { BotContext } from "../types/context.js";
import type { BotDependencies } from "../bot/dependencies.js";
import { requireOwner, requirePrivate } from "../bot/authorization.js";
import { adminPanelKeyboard } from "../keyboards/inline.js";
import { editOrReply } from "../bot/render.js";
import { showAdminPanel, showInventoryAdmin, showStatistics } from "../bot/admin-views.js";
import { createRedeemCodes } from "../services/codes.service.js";
import { giftAllActiveUsers, giftCredits, removeCredits } from "../services/credits.service.js";
import { getResetPreview, createResetChallenge, advanceResetChallenge, performConfirmedReset, cancelResetChallenge } from "../services/admin.service.js";
import { buildStoreExport } from "../services/export.service.js";
import { escapeHtml, formatDate, smallCaps } from "../utils/format.js";
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
    await ctx.reply(`⚠️ ${escapeHtml(error.message)}`, { parse_mode: "HTML" });
    return;
  }
  deps.logger.error({ err: error, command }, "Owner command failed");
  await ctx.reply("⚠️ Iris couldn't complete that command. Please try again or check the application logs.");
}

function resetSummary(preview: ResetPreview): string {
  return `• User profiles: ${preview.users}\n` +
    `• Categories: ${preview.categories}\n` +
    `• Products: ${preview.products}\n` +
    `• Inventory items: ${preview.inventory}\n` +
    `• Purchases: ${preview.purchases}\n` +
    `• Redeem codes: ${preview.redeemCodes}\n` +
    `• Code redemptions: ${preview.redemptions}\n` +
    `• Credit ledger entries: ${preview.creditTransactions}`;
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
  await ctx.replyWithDocument(new InputFile(buffer, filename), { caption });
}

export async function beginReset(ctx: BotContext, deps: BotDependencies): Promise<void> {
  const preview = await getResetPreview(deps.database.prisma);
  try {
    await sendStoreExport(ctx, deps, "⚠️ Pre-reset backup. This file contains all shop inventory payloads; store it safely.");
  } catch (error) {
    deps.logger.error({ err: error }, "Could not create the required pre-reset backup");
    await ctx.reply("I couldn't deliver a backup, so reset has not been armed. Use /export or check the database/export size.");
    return;
  }
  const challenge = await createResetChallenge(deps.database.prisma, deps.config.ownerId);
  const keyboard = new InlineKeyboard()
    .text("⚠️ CONTINUE", `reset:continue:${challenge.id}:${challenge.token}`)
    .text("❌ CANCEL", `reset:cancel:${challenge.id}`);
  await ctx.reply(
    `⚠️ <b>${smallCaps("Dangerous operation")}</b>\n\n` +
      `This will permanently delete the following store data:\n${resetSummary(preview)}\n\n` +
      `<b>Preserved:</b> runtime settings and admin audit history.\n` +
      `<b>Backup:</b> sent above. Confirmation expires ${escapeHtml(formatDate(challenge.expiresAt))}.\n\n` +
      `No data has been deleted. Continue only if you understand the scope.`,
    { parse_mode: "HTML", reply_markup: keyboard },
  );
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
    await editOrReply(ctx, "Backup delivery failed. Reset was not executed; let this confirmation expire and use /reset again.", adminPanelKeyboard(), deps.logger);
    return;
  }
  const keyboard = new InlineKeyboard()
    .text("⚠️ DELETE EVERYTHING", `reset:delete:${challengeId}:${token}`)
    .text("❌ CANCEL", `reset:cancel:${challengeId}`);
  await editOrReply(
    ctx,
    `⚠️ <b>${smallCaps("Final confirmation")}</b>\n\n` +
      `The fresh backup was sent above. The following will be deleted:\n${resetSummary(preview)}\n\n` +
      `Settings and admin audit history are preserved. This confirmation is one-time and expires shortly.`,
    keyboard,
    deps.logger,
  );
}

export async function completeReset(
  ctx: BotContext,
  deps: BotDependencies,
  challengeId: string,
  token: string,
): Promise<void> {
  const deleted = await performConfirmedReset(deps.database.prisma, challengeId, token, deps.config.ownerId);
  deps.logger.warn({ ownerId: deps.config.ownerId.toString(), deleted }, "Owner completed a full store reset");
  await editOrReply(
    ctx,
    `✅ <b>${smallCaps("Reset complete")}</b>\n\nDeleted ${deleted.users} user profile(s), ${deleted.products} product(s), ${deleted.inventory} inventory item(s), and all matching store records. Settings and reset audit history remain.`,
    adminPanelKeyboard(),
    deps.logger,
  );
}

export async function cancelReset(
  ctx: BotContext,
  deps: BotDependencies,
  challengeId: string,
): Promise<void> {
  await cancelResetChallenge(deps.database.prisma, challengeId, deps.config.ownerId);
  await editOrReply(ctx, "✅ Reset cancelled. Nothing was deleted.", adminPanelKeyboard(), deps.logger);
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
      void ctx.api.sendMessage(Number(deps.config.ownerId), "PM2 restart failed. Iris may still be running; please restart it from the host.")
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
      await ctx.reply(`✅ Added ${credits} credits. New balance: ${updated.credits}.`);
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
      await ctx.reply(`✅ Removed ${credits} credits. New balance: ${updated.credits}.`);
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
      await ctx.reply(`✅ Gifted ${credits} credits to ${result.recipients} users active within 72 hours. Skipped ${result.skipped} over-limit balance(s).`);
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
      await ctx.reply(
        `🔑 <b>${smallCaps("Credit codes created")}</b>\n${codes.map((code) => `<code>${code}</code>`).join("\n")}\n\nEach grants ${credits} credits · ${maxRedeems} redemption(s) per code.`,
        { parse_mode: "HTML" },
      );
    } catch (error) {
      await reportAdminCommandError(ctx, deps, "code", error);
    }
  });

  bot.command("broadcast", async (ctx) => {
    if (!(await requireOwner(ctx, deps.config)) || !(await requirePrivate(ctx))) return;
    const text = ctx.match.trim();
    if (text.length > 3_500) {
      await ctx.reply("Broadcast text is limited to 3,500 characters.");
      return;
    }
    if (text) {
      ctx.session.adminFlow = { kind: "broadcast:confirm", text };
      const sent = await ctx.reply(
        `📢 <b>Preview broadcast</b>\n\n${escapeHtml(text)}`,
        { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("📢 SEND TO USERS", "admin:broadcast:send").text("❌ CANCEL", "admin:broadcast:cancel") },
      );
      ctx.session.adminPanelChatId = sent.chat.id;
      ctx.session.adminPanelMessageId = sent.message_id;
      return;
    }
    ctx.session.adminFlow = { kind: "broadcast:message" };
    const sent = await ctx.reply("Send the plain-text broadcast now. Use /cancel to stop.");
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
      await ctx.reply("I couldn't create the export. Check the application logs or use a PostgreSQL backup.");
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
