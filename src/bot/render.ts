import { GrammyError, InputFile } from "grammy";
import type { InlineKeyboard } from "grammy";
import type { InputMediaPhoto } from "grammy/types";
import type { BotContext } from "../types/context.js";
import type { AppLogger } from "../utils/logger.js";

export function isUnchangedEdit(error: unknown): boolean {
  return error instanceof GrammyError && /message is not modified/i.test(error.description);
}

export async function editOrReply(
  ctx: BotContext,
  text: string,
  keyboard?: InlineKeyboard,
  logger?: AppLogger,
): Promise<void> {
  const callbackMessage = ctx.callbackQuery?.message;
  if (callbackMessage && "message_id" in callbackMessage && callbackMessage.date !== 0) {
    const chatId = callbackMessage.chat.id;
    const messageId = callbackMessage.message_id;
    const options = {
      ...(keyboard ? { reply_markup: keyboard } : {}),
      parse_mode: "HTML" as const,
      link_preview_options: { is_disabled: true },
    };
    const isMedia = "photo" in callbackMessage || "video" in callbackMessage ||
      "animation" in callbackMessage || "document" in callbackMessage;
    try {
      if (isMedia) {
        await ctx.api.editMessageCaption(chatId, messageId, {
          ...(keyboard ? { reply_markup: keyboard } : {}),
          parse_mode: "HTML",
          caption: text,
        });
      } else {
        await ctx.api.editMessageText(chatId, messageId, text, options);
      }
      return;
    } catch (error) {
      if (isUnchangedEdit(error)) return;
      logger?.debug({ err: error }, "Couldn't edit the current menu message; sending a fallback message");
    }
  }
  await ctx.reply(text, {
    ...(keyboard ? { reply_markup: keyboard } : {}),
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
}

export async function editAsPhoto(
  ctx: BotContext,
  media: InputMediaPhoto,
  keyboard: InlineKeyboard,
  fallbackPhoto: Buffer,
  caption: string,
  logger: AppLogger,
): Promise<void> {
  const callbackMessage = ctx.callbackQuery?.message;
  if (callbackMessage && "message_id" in callbackMessage && callbackMessage.date !== 0) {
    try {
      await ctx.api.editMessageMedia(
        callbackMessage.chat.id,
        callbackMessage.message_id,
        media,
        { reply_markup: keyboard },
      );
      return;
    } catch (error) {
      if (isUnchangedEdit(error)) return;
      logger.debug({ err: error }, "Could not replace menu media with profile photo");
    }
  }
  await ctx.replyWithPhoto(new InputFile(fallbackPhoto, "iris-avatar.png"), {
    caption,
    parse_mode: "HTML",
    reply_markup: keyboard,
  });
}
