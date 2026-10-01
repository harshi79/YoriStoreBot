import { Bot, session } from "grammy";
import type { BotDependencies } from "./dependencies.js";
import type { BotContext } from "../types/context.js";
import type { SessionData } from "../types/session.js";
import { touchUser } from "../services/users.service.js";
import { registerUserCommands } from "../commands/user.js";
import { registerAdminCommands } from "../commands/admin.js";
import { registerAdminFlow } from "../commands/admin-flow.js";
import { registerCallbacks } from "../callbacks/router.js";
import { createRateLimitMiddleware } from "../middleware/rate-limit.js";
import { GrammyError } from "grammy";
import { replyRichOrLegacy } from "./render.js";
import { richHeading, richParagraph } from "../messages/rich-ui.js";
import { smallCaps } from "../utils/format.js";

export function createBot(deps: BotDependencies): Bot<BotContext> {
  const bot = new Bot<BotContext>(deps.config.botToken);

  bot.use(session<SessionData, BotContext>({
    initial: () => ({ adminFlow: null, purchaseConfirmation: null }),
    getSessionKey: (ctx) => ctx.from?.id.toString(),
  }));
  bot.use(createRateLimitMiddleware());
  bot.use(async (ctx, next) => {
    if (ctx.from && ctx.chat?.type === "private") {
      await touchUser(deps.database.prisma, ctx.from);
    }
    await next();
  });

  registerUserCommands(bot, deps);
  registerAdminCommands(bot, deps);
  registerCallbacks(bot, deps);
  registerAdminFlow(bot, deps);

  bot.on("message:text", async (ctx) => {
    if (ctx.chat?.type !== "private") return;
    const fallback = smallCaps("Iris is ready when you are. Use /start to open the store or /help to see what I can do.");
    await replyRichOrLegacy(ctx, {
      blocks: [
        richHeading("🛍 Iris is ready", 1),
        richParagraph("Use /start to open the store, or /help to see the available commands.", true),
      ],
    }, fallback, { logger: deps.logger });
  });

  bot.catch(async ({ ctx, error }) => {
    deps.logger.error({
      err: error,
      updateId: ctx.update.update_id,
      telegramId: ctx.from?.id,
      apiError: error instanceof GrammyError ? error.error_code : undefined,
    }, "Telegram update failed");
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({ text: smallCaps("Something went wrong. Please try again."), show_alert: true })
        .catch(() => undefined);
      if (ctx.chat?.type === "private") {
        await replyRichOrLegacy(ctx, {
          blocks: [richHeading("⚠️ Action not completed", 1), richParagraph("Please try again or use /help.", true)],
        }, smallCaps("Iris couldn't complete that action. Please try again or use /help."), { logger: deps.logger })
          .catch(() => undefined);
      }
    } else if (ctx.chat?.type === "private") {
      await replyRichOrLegacy(ctx, {
        blocks: [richHeading("⚠️ Request not completed", 1), richParagraph("Please try again or use /help.", true)],
      }, smallCaps("Iris couldn't complete that request. Please try again or use /help."), { logger: deps.logger })
        .catch(() => undefined);
    }
  });

  return bot;
}
