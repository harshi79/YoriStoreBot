import type { BotContext } from "../types/context.js";
import type { MiddlewareFn } from "grammy";

const COMMAND_LIMITS: Record<string, number> = {
  bonus: 1_000,
  redeem: 1_500,
  gift: 1_000,
  rm: 1_000,
  giftall: 2_000,
  code: 2_000,
  broadcast: 2_000,
  reset: 3_000,
};

const CALLBACK_LIMITS: Array<[RegExp, number]> = [
  [/^buy:confirm:/, 1_000],
  [/^bonus:claim$/, 1_000],
  [/^reset:(?:continue|delete):/, 1_500],
];

export function createRateLimitMiddleware(): MiddlewareFn<BotContext> {
  const lastCall = new Map<string, number>();
  return async (ctx, next) => {
    const telegramId = ctx.from?.id;
    if (!telegramId || ctx.chat?.type !== "private") return next();

    const messageText = ctx.message && "text" in ctx.message ? ctx.message.text : "";
    const command = messageText.match(/^\/(\w+)/)?.[1]?.toLowerCase();
    let action = command && COMMAND_LIMITS[command] ? command : undefined;
    let interval = action ? COMMAND_LIMITS[action] : undefined;
    const callbackData = ctx.callbackQuery?.data;
    if (callbackData !== undefined) {
      const rule = CALLBACK_LIMITS.find(([pattern]) => pattern.test(callbackData));
      if (rule) {
        action = rule[0].source;
        interval = rule[1];
      }
    }
    if (!action || interval === undefined) return next();

    const now = Date.now();
    const key = `${telegramId}:${action}`;
    const previous = lastCall.get(key) ?? 0;
    if (now - previous < interval) {
      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery({ text: "One moment, please.", show_alert: false }).catch(() => undefined);
      } else {
        await ctx.reply("One moment, please.");
      }
      return;
    }
    lastCall.set(key, now);
    if (lastCall.size > 20_000) {
      for (const [oldKey, timestamp] of lastCall) {
        if (now - timestamp > 60_000) lastCall.delete(oldKey);
      }
    }
    await next();
  };
}
