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
import { editOrReplyRich, replyRichOrLegacy } from "../bot/render.js";
import { richButtonRow, richCallbackButton, richHeading, richKeyValueTable, richParagraph } from "../messages/rich-ui.js";
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
      const text = `🔍 <b>${smallCaps("Search Iris store")}</b>\n\n${smallCaps("Send a keyword (for example, crunchyroll, netflix, or premium) or use")} <code>/cancel</code>.`;
      await editOrReplyRich(ctx, {
        blocks: [
          richHeading("🔍 Search Iris store", 1),
          richParagraph("Send a keyword such as crunchyroll, netflix, or premium. Use /cancel to stop.", true),
          richButtonRow([richCallbackButton("◀ Store", "nav:store", "link")]),
        ],
      }, text, {
        fallbackKeyboard: new InlineKeyboard().text(smallCaps("◀ STORE"), "nav:store"),
        logger: deps.logger,
      });
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
      await replyRichOrLegacy(ctx, {
        blocks: [
          richHeading("🎟 Redeem a credit code", 1),
          richParagraph([smallCaps("Use "), { type: "code", text: "/redeem IRIS-XXXX-XXXX-XXXX" }, smallCaps(" to claim credits.")]),
        ],
      }, `${smallCaps("Use")} /redeem IRIS-XXXX-XXXX-XXXX`, { fallbackKeyboard: mainKeyboard(), logger: deps.logger });
      return;
    }
    try {
      const user = await findUserByTelegramId(deps.database.prisma, ctx.from!.id);
      const result = await redeemCode(deps.database.prisma, user.id, code);
      const text = `🎉 <b>${smallCaps("Code redeemed")}</b>\n\n✦ +${creditLabel(result.credits)}\n💰 ${smallCaps("Balance")}: ${creditLabel(result.balance)}`;
      await editOrReplyRich(ctx, {
        blocks: [
          richHeading("🎉 Code redeemed", 1),
          richKeyValueTable([
            ["Credits received", `+${creditLabel(result.credits)}`],
            ["New balance", creditLabel(result.balance)],
          ], "Redemption receipt"),
          richButtonRow([
            richCallbackButton("🛍 Store", "nav:store", "primary"),
            richCallbackButton("👤 Profile", "nav:profile"),
            richCallbackButton("🏠 Home", "nav:home", "link"),
          ]),
        ],
      }, text, { fallbackKeyboard: mainKeyboard(), logger: deps.logger });
    } catch (error) {
      if (error instanceof AlreadyRedeemedError || error instanceof CodeUnavailableError || error instanceof DomainError) {
        await replyRichOrLegacy(ctx, {
          blocks: [richHeading("⚠️ Code not redeemed", 1), richParagraph(error.message)],
        }, `⚠️ ${escapeHtml(error.message)}`, { fallbackKeyboard: mainKeyboard(), logger: deps.logger });
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
    await replyRichOrLegacy(ctx, {
      blocks: [richHeading("Form cancelled", 1), richParagraph("The current form has been cancelled. Nothing else was changed.", true)],
    }, smallCaps("Current Iris form cancelled."), { fallbackKeyboard: mainKeyboard(), logger: deps.logger });
  });
}
