import { GrammyError, InlineKeyboard, InputFile } from "grammy";
import type { InputMediaPhoto, InputRichMessage, InlineKeyboardButton, Message } from "grammy/types";
import type { BotContext } from "../types/context.js";
import type { AppLogger } from "../utils/logger.js";
import { escapeHtml, smallCaps } from "../utils/format.js";

export function isUnchangedEdit(error: unknown): boolean {
  return error instanceof GrammyError && /message is not modified/i.test(error.description);
}

async function editOrReplyLegacy(
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

function richButtonHtml(button: InlineKeyboardButton): string | null {
  const label = escapeHtml(smallCaps(button.text));
  const style = button.style ? ` style="${escapeHtml(button.style)}"` : "";
  if ("callback_data" in button) {
    return `<tg-button type="callback_data" data="${escapeHtml(button.callback_data)}"${style}>${label}</tg-button>`;
  }
  if ("url" in button) {
    return `<tg-button type="url" url="${escapeHtml(button.url)}"${style}>${label}</tg-button>`;
  }
  if ("web_app" in button) {
    return `<tg-button type="web_app" url="${escapeHtml(button.web_app.url)}"${style}>${label}</tg-button>`;
  }
  if ("login_url" in button) {
    if (button.login_url.bot_username) return null;
    const forwardText = button.login_url.forward_text
      ? ` forward-text="${escapeHtml(button.login_url.forward_text)}"`
      : "";
    const requestWriteAccess = button.login_url.request_write_access ? " request-write-access" : "";
    return `<tg-button type="login_url" url="${escapeHtml(button.login_url.url)}"${forwardText}${requestWriteAccess}${style}>${label}</tg-button>`;
  }
  if ("switch_inline_query" in button) {
    return `<tg-button type="switch_inline_query" query="${escapeHtml(button.switch_inline_query)}"${style}>${label}</tg-button>`;
  }
  if ("switch_inline_query_current_chat" in button) {
    return `<tg-button type="switch_inline_query_current_chat" query="${escapeHtml(button.switch_inline_query_current_chat)}"${style}>${label}</tg-button>`;
  }
  if ("switch_inline_query_chosen_chat" in button) {
    const choice = button.switch_inline_query_chosen_chat;
    const query = choice.query ? ` query="${escapeHtml(choice.query)}"` : "";
    const allow = [
      choice.allow_user_chats ? " allow-user-chats" : "",
      choice.allow_bot_chats ? " allow-bot-chats" : "",
      choice.allow_group_chats ? " allow-group-chats" : "",
      choice.allow_channel_chats ? " allow-channel-chats" : "",
    ].join("");
    return `<tg-button type="switch_inline_query_chosen_chat"${query}${allow}${style}>${label}</tg-button>`;
  }
  if ("copy_text" in button) {
    return `<tg-button type="copy_text" text="${escapeHtml(button.copy_text.text)}"${style}>${label}</tg-button>`;
  }
  if ("disabled" in button) return `<tg-button type="disabled"${style}>${label}</tg-button>`;
  return null;
}

function richKeyboardHtml(keyboard?: InlineKeyboard): string | null {
  if (!keyboard) return "";
  const rows: string[] = [];
  for (const row of keyboard.inline_keyboard) {
    const buttons = row.map(richButtonHtml);
    if (buttons.some((button) => button === null)) return null;
    if (buttons.length) rows.push(`<tg-button-row>${buttons.join("")}</tg-button-row>`);
  }
  return rows.join("\n");
}

export function richHtmlMessage(text: string, keyboard?: InlineKeyboard): InputRichMessage {
  const buttonRows = richKeyboardHtml(keyboard);
  if (buttonRows === null) throw new RangeError("This inline keyboard cannot be represented in rich HTML.");
  return { html: buttonRows ? `${text}\n${buttonRows}` : text };
}

export async function editOrReply(
  ctx: BotContext,
  text: string,
  keyboard?: InlineKeyboard,
  logger?: AppLogger,
): Promise<void> {
  const buttonRows = richKeyboardHtml(keyboard);
  if (buttonRows === null) {
    await editOrReplyLegacy(ctx, text, keyboard, logger);
    return;
  }
  await editOrReplyRich(ctx, { html: buttonRows ? `${text}\n${buttonRows}` : text }, text, {
    ...(keyboard ? { fallbackKeyboard: keyboard } : {}),
    ...(logger ? { logger } : {}),
  });
}

export interface RichReplyOptions {
  /** Inline keyboard shown only when the rich message is unavailable. */
  fallbackKeyboard?: InlineKeyboard;
  logger?: AppLogger;
}

export async function replyRichOrLegacy(
  ctx: BotContext,
  richMessage: InputRichMessage,
  fallbackText: string,
  options: RichReplyOptions = {},
): Promise<Message.RichMessageMessage | Message.TextMessage> {
  try {
    return await ctx.replyWithRichMessage(richMessage);
  } catch (error) {
    options.logger?.debug({ err: error }, "Rich message send failed; falling back to HTML");
    return await ctx.reply(fallbackText, {
      ...(options.fallbackKeyboard ? { reply_markup: options.fallbackKeyboard } : {}),
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  }
}

export async function sendRichOrLegacy(
  ctx: BotContext,
  chatId: number | string,
  richMessage: InputRichMessage,
  fallbackText: string,
  options: RichReplyOptions = {},
): Promise<Message.RichMessageMessage | Message.TextMessage> {
  try {
    return await ctx.api.sendRichMessage(chatId, richMessage);
  } catch (error) {
    options.logger?.debug({ err: error }, "Rich message send failed; falling back to HTML");
    return await ctx.api.sendMessage(chatId, fallbackText, {
      ...(options.fallbackKeyboard ? { reply_markup: options.fallbackKeyboard } : {}),
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  }
}

export async function editMessageRichOrLegacy(
  ctx: BotContext,
  chatId: number | string,
  messageId: number,
  richMessage: InputRichMessage,
  fallbackText: string,
  options: RichReplyOptions = {},
): Promise<void> {
  try {
    await ctx.api.editMessageText(chatId, messageId, richMessage, {
      reply_markup: new InlineKeyboard(),
    });
    return;
  } catch (error) {
    if (isUnchangedEdit(error)) return;
    options.logger?.debug({ err: error }, "Rich message edit failed; falling back to HTML");
  }

  const fallbackOptions = {
    ...(options.fallbackKeyboard ? { reply_markup: options.fallbackKeyboard } : {}),
    parse_mode: "HTML" as const,
    link_preview_options: { is_disabled: true },
  };
  try {
    await ctx.api.editMessageText(chatId, messageId, fallbackText, fallbackOptions);
  } catch (error) {
    if (isUnchangedEdit(error)) return;
    options.logger?.debug({ err: error }, "Legacy message edit failed; sending the fallback as a new message");
    await ctx.api.sendMessage(chatId, fallbackText, fallbackOptions);
  }
}

export async function editOrReplyRich(
  ctx: BotContext,
  richMessage: InputRichMessage,
  fallbackText: string,
  options: RichReplyOptions = {},
): Promise<void> {
  const { fallbackKeyboard, logger } = options;
  const source = ctx.callbackQuery?.message;
  if (source && "message_id" in source && source.date !== 0) {
    const isMedia = "photo" in source || "video" in source || "animation" in source || "document" in source;
    if (isMedia) {
      try {
        await ctx.api.deleteMessage(source.chat.id, source.message_id);
      } catch (error) {
        logger?.debug({ err: error }, "Could not replace the media menu with a rich message");
      }
    } else {
      try {
        await ctx.api.editMessageText(source.chat.id, source.message_id, richMessage, {
          // Editing with an empty keyboard removes stale buttons from the previous screen.
          reply_markup: new InlineKeyboard(),
        });
        return;
      } catch (error) {
        if (isUnchangedEdit(error)) return;
        logger?.debug({ err: error }, "Rich message edit failed; falling back to HTML");
        await editOrReplyLegacy(ctx, fallbackText, fallbackKeyboard, logger);
        return;
      }
    }
  }

  await replyRichOrLegacy(ctx, richMessage, fallbackText, {
    ...(fallbackKeyboard ? { fallbackKeyboard } : {}),
    ...(logger ? { logger } : {}),
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
