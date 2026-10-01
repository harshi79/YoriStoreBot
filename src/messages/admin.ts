import type { InputRichMessage } from "grammy/types";
import { richButtonRow, richCallbackButton } from "./rich-ui.js";

export function adminPanelMessage(): InputRichMessage {
  return {
    blocks: [
      { type: "heading", size: 1, text: "👑 Iris · Owner console" },
      {
        type: "paragraph",
        text: "Your store control center. Choose a workspace to manage products, stock, customers, and operations.",
      },
      { type: "heading", size: 4, text: "CATALOG" },
      richButtonRow([
        richCallbackButton("📦 Products", "admin:products:0", "primary"),
        richCallbackButton("🗂 Categories", "admin:categories"),
      ]),
      { type: "heading", size: 4, text: "FULFILMENT" },
      richButtonRow([
        richCallbackButton("📋 Inventory", "admin:inventory", "primary"),
        richCallbackButton("🔑 Codes", "admin:codes:0"),
      ]),
      { type: "heading", size: 4, text: "CUSTOMERS & ORDERS" },
      richButtonRow([
        richCallbackButton("👥 Users", "admin:users:0"),
        richCallbackButton("🎁 Credits", "admin:credits"),
        richCallbackButton("🧾 Purchases", "admin:purchases:0"),
        richCallbackButton("🛡 Warranty", "admin:warranty:0"),
      ]),
      { type: "heading", size: 4, text: "GROWTH & REPORTING" },
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
      {
        type: "footer",
        text: "Owner-only controls. Reset always sends a backup and requires two confirmations.",
      },
    ],
  };
}
