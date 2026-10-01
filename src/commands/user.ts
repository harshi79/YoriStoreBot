import { InlineKeyboard } from "grammy";
import type { Bot } from "grammy";
import type { BotContext } from "../types/context.js";
import type { BotDependencies } from "../bot/dependencies.js";
import { requirePrivate } from "../bot/authorization.js";
import {
  claimBonus,
  sendWelcomeVideo,
  showHelp,
  showOrders,
  showProfile,
  showWallet,
  showStore,
  showStoreSearchResults,
} from "../bot/views.js";
import { redeemCode } from "../services/codes.service.js";
import { findUserByTelegramId } from "../services/users.service.js";
import { mainKeyboard } from "../keyboards/inline.js";
import { creditLabel, escapeHtml, smallCaps } from "../utils/format.js";
import { AlreadyRedeemedError, CodeUnavailableError, DomainError } from "../utils/errors.js";

export function registerUserCommands(bot: Bot<BotContext>, deps: BotDependencies): void {
  bot.command("start", async (ctx) => {
    if (!(await requirePrivate(ctx))) return;
    ctx.session.adminFlow = null;
    ctx.session.userFlow = null;
    ctx.session.purchaseConfirmation = null;
    await sendWelcomeVideo(ctx, deps);
  });

  bot.command("store", async (ctx) => {
    if (!(await requirePrivate(ctx))) return;
    ctx.session.userFlow = null;
    await showStore(ctx, deps);
  });

  bot.command("search", async (ctx) => {
    if (!(await requirePrivate(ctx))) return;
    const query = ctx.match.trim();
    if (!query) {
      ctx.session.userFlow = { kind: "store:search" };
      await ctx.reply(
        `🔍 <b>${smallCaps("Search Iris store")}</b>\n\nSend a keyword (e.g. <code>crunchyroll</code>, <code>netflix</code>, <code>premium</code>) or use /cancel.`,
        {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard().text("◀ STORE", "nav:store"),
        },
      );
      return;
    }
    ctx.session.userFlow = null;
    await showStoreSearchResults(ctx, deps, query);
  });

  bot.command("profile", async (ctx) => {
    if (!(await requirePrivate(ctx))) return;
    ctx.session.userFlow = null;
    await showProfile(ctx, deps);
  });

  bot.command("wallet", async (ctx) => {
    if (!(await requirePrivate(ctx))) return;
    ctx.session.userFlow = null;
    await showWallet(ctx, deps);
  });

  bot.command("bonus", async (ctx) => {
    if (!(await requirePrivate(ctx))) return;
    ctx.session.userFlow = null;
    await claimBonus(ctx, deps);
  });

  bot.command("redeem", async (ctx) => {
    if (!(await requirePrivate(ctx))) return;
    const code = ctx.match.trim();
    if (!code) {
      await ctx.reply("Use /redeem IRIS-XXXX-XXXX-XXXX", { reply_markup: mainKeyboard() });
      return;
    }
    try {
      const user = await findUserByTelegramId(deps.database.prisma, ctx.from!.id);
      const result = await redeemCode(deps.database.prisma, user.id, code);
      await ctx.reply(
        `🎉 <b>Code redeemed</b>\n\n✦ +${creditLabel(result.credits)}\n💰 Balance: ${creditLabel(result.balance)}`,
        { parse_mode: "HTML", reply_markup: mainKeyboard() },
      );
    } catch (error) {
      if (error instanceof AlreadyRedeemedError || error instanceof CodeUnavailableError || error instanceof DomainError) {
        await ctx.reply(`⚠️ ${escapeHtml(error.message)}`, { parse_mode: "HTML", reply_markup: mainKeyboard() });
        return;
      }
      throw error;
    }
  });

  bot.command("orders", async (ctx) => {
    if (!(await requirePrivate(ctx))) return;
    ctx.session.userFlow = null;
    await showOrders(ctx, deps);
  });

  bot.command("help", async (ctx) => {
    if (!(await requirePrivate(ctx))) return;
    ctx.session.userFlow = null;
    await showHelp(ctx, deps);
  });

  bot.command("cancel", async (ctx) => {
    ctx.session.adminFlow = null;
    ctx.session.userFlow = null;
    ctx.session.purchaseConfirmation = null;
    if (!(await requirePrivate(ctx))) return;
    await ctx.reply("Current Iris form cancelled.", { reply_markup: mainKeyboard() });
  });
}
