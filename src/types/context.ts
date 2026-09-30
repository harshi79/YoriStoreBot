import type { Context } from "grammy";
import type { SessionFlavor } from "grammy";
import type { SessionData } from "./session.js";

export type BotContext = Context & SessionFlavor<SessionData>;
