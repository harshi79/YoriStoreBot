import type { Api } from "grammy";
import type { BotCommand } from "grammy/types";
import type { AppLogger } from "../utils/logger.js";

/** Commands shown in every private chat. Owner operations stay out of the public menu. */
export const PUBLIC_COMMANDS = [
  { command: "start", description: "Open the Iris store" },
  { command: "store", description: "Browse categories and products" },
  { command: "search", description: "Search the product catalog" },
  { command: "profile", description: "View your profile and credits" },
  { command: "wallet", description: "View your credit activity" },
  { command: "bonus", description: "Claim your daily credits" },
  { command: "redeem", description: "Redeem a credit code" },
  { command: "orders", description: "View your purchase history" },
  { command: "help", description: "Get help using Iris" },
  { command: "cancel", description: "Cancel the current form" },
] as const satisfies readonly BotCommand[];

/** /admin is visible to everyone, but its handler remains owner-authorized. */
export const COMMAND_MENU = [
  ...PUBLIC_COMMANDS,
  { command: "admin", description: "Open the owner panel (owner only)" },
] as const satisfies readonly BotCommand[];

type CommandMenuApi = Pick<Api, "setMyCommands">;

/**
 * Synchronize the default, all-private, and owner-chat scopes. Telegram keeps
 * per-chat command overrides, so writing the reduced menu to the owner scope also
 * clears admin commands installed by older releases.
 */
export async function registerCommandMenus(
  api: CommandMenuApi,
  ownerId: bigint,
  logger: AppLogger,
): Promise<void> {
  try {
    await api.setMyCommands([...COMMAND_MENU], {
      scope: { type: "default" },
    });
  } catch (error) {
    logger.warn({ err: error }, "Could not register default chat commands");
  }

  try {
    await api.setMyCommands([...COMMAND_MENU], {
      scope: { type: "all_private_chats" },
    });
  } catch (error) {
    logger.warn({ err: error }, "Could not register private chat commands");
  }

  try {
    await api.setMyCommands([...COMMAND_MENU], {
      scope: { type: "chat", chat_id: Number(ownerId) },
    });
  } catch (error) {
    logger.warn(
      { err: error, ownerId: ownerId.toString() },
      "Could not synchronize the owner command menu yet (the owner may not have started a chat with the bot)",
    );
  }
}
