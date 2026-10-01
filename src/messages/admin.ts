import type { InputRichMessage } from "grammy/types";
import { richButtonRow, richCallbackButton, richFooter, richHeading, richParagraph } from "./rich-ui.js";
import { smallCaps } from "../utils/format.js";

export function adminPanelMessage(): InputRichMessage {
  return {
    blocks: [
      richHeading("👑 Iris · Owner console", 1),
      richParagraph("Your store control center. Choose a workspace to manage products, stock, customers, and operations.", true),
      richHeading("Catalog", 4),
      richButtonRow([
        richCallbackButton("📦 Products", "admin:products:0", "primary"),
        richCallbackButton("🗂 Categories", "admin:categories"),
      ]),
      richHeading("Fulfilment", 4),
      richButtonRow([
        richCallbackButton("📋 Inventory", "admin:inventory", "primary"),
        richCallbackButton("🔑 Codes", "admin:codes:0"),
      ]),
      richHeading("Customers & orders", 4),
      richButtonRow([
        richCallbackButton("👥 Users", "admin:users:0"),
        richCallbackButton("🎁 Credits", "admin:credits"),
        richCallbackButton("🧾 Purchases", "admin:purchases:0"),
        richCallbackButton("🛡 Warranty", "admin:warranty:0"),
      ]),
      richHeading("Growth & reporting", 4),
      richButtonRow([
        richCallbackButton("📢 Broadcast", "admin:broadcast"),
        richCallbackButton("📊 Statistics", "admin:stats"),
        richCallbackButton("📤 Export", "admin:export"),
        richCallbackButton("⚙️ Settings", "admin:settings"),
      ]),
      { type: "divider" },
      richButtonRow([
        richCallbackButton("🔄 Restart", "admin:restart"),
        richCallbackButton("⚠️ Reset store", "admin:reset", "danger"),
      ]),
      richButtonRow([
        richCallbackButton("🏠 Storefront", "nav:home", "link"),
      ]),
      richFooter(smallCaps("Owner-only controls. Reset always sends a backup and requires two confirmations.")),
    ],
  };
}
