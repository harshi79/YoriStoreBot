import type { BotContext } from "../types/context.js";
import type { AppConfig } from "../config/env.js";
import { replyRichOrLegacy } from "./render.js";
import { richHeading, richParagraph } from "../messages/rich-ui.js";
import { smallCaps } from "../utils/format.js";

export function isOwner(ctx: BotContext, config: AppConfig): boolean {
  return ctx.from !== undefined && BigInt(ctx.from.id) === config.ownerId;
}

export async function requireOwner(ctx: BotContext, config: AppConfig): Promise<boolean> {
  if (isOwner(ctx, config)) return true;
  const message = "⛔ This area is reserved for the Iris owner.";
  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery({ text: smallCaps(message), show_alert: true }).catch(() => undefined);
  } else {
    await replyRichOrLegacy(ctx, {
      blocks: [richHeading("⛔ Owner access", 1), richParagraph("This area is reserved for the Iris owner.", true)],
    }, smallCaps(message));
  }
  return false;
}

export async function requirePrivate(ctx: BotContext): Promise<boolean> {
  if (ctx.chat?.type === "private") return true;
  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery({ text: smallCaps("Open Iris in a private chat to continue."), show_alert: true })
      .catch(() => undefined);
  } else {
    await replyRichOrLegacy(ctx, {
      blocks: [
        richHeading("🔒 Private chat required", 1),
        richParagraph("Please open Iris in a private chat to continue.", true),
      ],
    }, smallCaps("Please open Iris in a private chat to continue."));
  }
  return false;
}
