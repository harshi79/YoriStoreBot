import type { BotContext } from "../types/context.js";
import type { AppConfig } from "../config/env.js";

export function isOwner(ctx: BotContext, config: AppConfig): boolean {
  return ctx.from !== undefined && BigInt(ctx.from.id) === config.ownerId;
}

export async function requireOwner(ctx: BotContext, config: AppConfig): Promise<boolean> {
  if (isOwner(ctx, config)) return true;
  const message = "⛔ This area is reserved for the Iris owner.";
  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery({ text: message, show_alert: true }).catch(() => undefined);
  } else {
    await ctx.reply(message);
  }
  return false;
}

export async function requirePrivate(ctx: BotContext): Promise<boolean> {
  if (ctx.chat?.type === "private") return true;
  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery({ text: "Open Iris in a private chat to continue.", show_alert: true })
      .catch(() => undefined);
  } else {
    await ctx.reply("Please open Iris in a private chat to continue.");
  }
  return false;
}
