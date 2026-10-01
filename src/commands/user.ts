import { InlineKeyboard } from "grammy";
import type { Bot } from "grammy";
import type { BotContext } from "../types/context.js";
import type { BotDependencies } from "../bot/dependencies.js";
import { requirePrivate } from "../bot/authorization.js";
import {
  claimBonus,
  sendWelcomeVideo,
  showHelp,
  showMyReferrals,
  showOrders,
  showProfile,
  showReferrals,
  showWallet,
  showStore,
  showStoreSearchResults,
} from "../bot/views.js";
import { redeemCode } from "../services/codes.service.js";
import { processReferralStart } from "../services/referrals.service.js";
import { findUserByTelegramId } from "../services/users.service.js";
import { mainKeyboard } from "../keyboards/inline.js";
import { creditLabel, escapeHtml, smallCaps } from "../utils/format.js";
import { editOrReplyRich, replyRichOrLegacy, sendRichOrLegacy } from "../bot/render.js";
import { richButtonRow, richCallbackButton, richHeading, richKeyValueTable, richParagraph } from "../messages/rich-ui.js";
import { AlreadyRedeemedError, CodeUnavailableError, DomainError } from "../utils/errors.js";

export function registerUserCommands(bot: Bot<BotContext>, deps: BotDependencies): void {
  bot.command("app", async (ctx) => {
    if (!(await requirePrivate(ctx))) return;
    if (!deps.config.miniAppUrl) {
      await ctx.reply("The Mini App is not configured yet. You can still use /store, /wallet, /profile and /orders here.");
      return;
    }
    await ctx.reply("Your Iris space — store, wallet, orders and profile, all together.", {
      reply_markup: new InlineKeyboard().webApp("Open Iris Mini App ↗", deps.config.miniAppUrl),
    });
  });

  bot.command("start", async (ctx) => {
    if (!(await requirePrivate(ctx))) return;
    ctx.session.adminFlow = null;
    ctx.session.userFlow = null;
    ctx.session.purchaseConfirmation = null;
    const rawPayload = ctx.match.trim();
    const startResult = await processReferralStart(
      deps.database.prisma,
      ctx.from!,
      rawPayload,
      {
        referrerCredits: deps.config.referralRewardCredits,
        inviteeCredits: deps.config.referralWelcomeCredits,
      },
    );
    await sendWelcomeVideo(ctx, deps);
    if (deps.config.miniAppUrl) {
      await ctx.reply("✦ Your digital happy place, now in one beautiful space.", {
        reply_markup: new InlineKeyboard().webApp("Open Iris Mini App ↗", deps.config.miniAppUrl),
      });
    }

    if (startResult.referralApplied && startResult.referrer) {
      const referrerLabel = startResult.referrer.username
        ? `@${startResult.referrer.username}`
        : startResult.referrer.firstName || `User ${startResult.referrer.telegramId.toString()}`;
      const welcomeBonusLine = startResult.inviteeCreditsAwarded > 0
        ? `\n🎁 <b>${smallCaps("Welcome bonus")}:</b> +${creditLabel(startResult.inviteeCreditsAwarded)}\n💰 <b>${smallCaps("Your balance")}:</b> ${creditLabel(startResult.user.credits)}`
        : "";
      const inviteeText = `🤝 <b>${smallCaps("Referral linked")}</b>\n\n` +
        `${smallCaps("You joined Iris via")} <b>${escapeHtml(referrerLabel)}</b>.` +
        welcomeBonusLine;
      await replyRichOrLegacy(
        ctx,
        {
          blocks: [
            richHeading("🤝 Welcome referral bonus", 1),
            richKeyValueTable([
              ["Invited by", referrerLabel],
              ...(startResult.inviteeCreditsAwarded > 0
                ? [
                    ["Welcome bonus", `+${creditLabel(startResult.inviteeCreditsAwarded)}`],
                    ["Your balance", creditLabel(startResult.user.credits)],
                  ] as Array<[string, string]>
                : []),
            ], "Referral welcome"),
            richButtonRow([
              richCallbackButton("🛍 Browse store", "nav:store", "primary"),
              richCallbackButton("🤝 Refer & earn", "nav:refer"),
            ]),
          ],
        },
        inviteeText,
        { logger: deps.logger },
      );

      if (startResult.referrer.creditsAwarded > 0) {
        const inviteeLabel = ctx.from?.username
          ? `@${ctx.from.username}`
          : ctx.from?.first_name || `User ${ctx.from!.id}`;
        const referrerFallback = `🎉 <b>${smallCaps("New referral reward!")}</b>\n\n` +
          `<b>${escapeHtml(inviteeLabel)}</b> ${smallCaps("joined Iris using your invite link.")}\n` +
          `✦ +${creditLabel(startResult.referrer.creditsAwarded)}\n` +
          `💰 <b>${smallCaps("New balance")}:</b> ${creditLabel(startResult.referrer.balanceAfter)}`;
        await sendRichOrLegacy(
          ctx,
          Number(startResult.referrer.telegramId),
          {
            blocks: [
              richHeading("🎉 New referral reward", 1),
              richParagraph("A new friend joined Iris using your personal invite link!", true),
              richKeyValueTable([
                ["New friend", inviteeLabel],
                ["Credits earned", `+${creditLabel(startResult.referrer.creditsAwarded)}`],
                ["New balance", creditLabel(startResult.referrer.balanceAfter)],
              ], "Referral reward"),
              richButtonRow([
                richCallbackButton("👥 My referrals", "refer:list:0", "primary"),
                richCallbackButton("🤝 Refer & earn", "nav:refer"),
              ]),
            ],
          },
          referrerFallback,
          { logger: deps.logger },
        ).catch((err: unknown) => {
          deps.logger.debug({ err, referrerTelegramId: startResult.referrer?.telegramId.toString() }, "Could not send referral notification to referrer");
        });
      }
    } else if (rawPayload && /^(?:ref_|r_)/i.test(rawPayload)) {
      if (startResult.referralIgnoreReason === "self_referral") {
        await replyRichOrLegacy(
          ctx,
          {
            blocks: [
              richHeading("⚠️ Own referral link", 1),
              richParagraph("You cannot use your own referral link. Share it with a friend to earn credits!", true),
              richButtonRow([richCallbackButton("🤝 Refer & earn", "nav:refer", "primary")]),
            ],
          },
          `⚠️ ${smallCaps("You cannot use your own referral link. Share it with a friend to earn credits!")}`,
          { logger: deps.logger },
        );
      } else if (startResult.referralIgnoreReason === "already_registered") {
        await replyRichOrLegacy(
          ctx,
          {
            blocks: [
              richHeading("ℹ️ Already registered", 1),
              richParagraph("Referral links apply only when joining Iris for the first time. Invite your own friends to earn credits!", true),
              richButtonRow([richCallbackButton("🤝 Refer & earn", "nav:refer", "primary")]),
            ],
          },
          `ℹ️ ${smallCaps("Referral links apply only when joining Iris for the first time.")}`,
          { logger: deps.logger },
        );
      }
    }
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

  bot.command(["refer", "referrals"], async (ctx) => {
    if (!(await requirePrivate(ctx))) return;
    ctx.session.userFlow = null;
    await showReferrals(ctx, deps);
  });

  bot.command("myreferrals", async (ctx) => {
    if (!(await requirePrivate(ctx))) return;
    ctx.session.userFlow = null;
    await showMyReferrals(ctx, deps, 0);
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
