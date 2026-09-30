import { creditLabel, escapeHtml, formatDate, safeText, smallCaps } from "../utils/format.js";
import { parseDeliveryPayload } from "../utils/credential-parser.js";
import type { PurchaseResult } from "../services/purchases.service.js";

export function welcomeMessage(firstName: string | null | undefined): string {
  const name = escapeHtml(safeText(firstName, "friend"));
  return `✦ <b>${smallCaps("Hello, I'm Iris")}</b> ✦\n\n` +
    `<i>${smallCaps("Your digital store assistant")}</i>\n\n` +
    `${smallCaps("Discover authorized digital goods, collect credits, and get your purchases delivered privately.")}\n\n` +
    `👤 ${smallCaps("Profile")}: check your balance and account\n` +
    `🎁 ${smallCaps("Bonus")}: claim your daily credits\n` +
    `🛍 ${smallCaps("Store")}: find something you love\n\n` +
    `${smallCaps("Hello")}, ${name} ✦`;
}

export function profileMessage(input: {
  displayName: string;
  username: string | null;
  telegramId: bigint;
  credits: number;
  purchaseCount: number;
  createdAt: Date;
  lastActiveAt: Date;
  nextBonusAt: Date | null;
  bonusAvailable: boolean;
}): string {
  return `◈ <b>${smallCaps("Your Iris profile")}</b>\n\n` +
    `👤 <b>${smallCaps("Name")}:</b> ${escapeHtml(input.displayName)}\n` +
    `✦ <b>${smallCaps("Username")}:</b> ${input.username ? `@${escapeHtml(input.username)}` : smallCaps("Not set")}\n` +
    `🆔 <b>${smallCaps("Telegram ID")}:</b> <code>${input.telegramId.toString()}</code>\n` +
    `💳 <b>${smallCaps("Credits")}:</b> ${creditLabel(input.credits)}\n` +
    `📦 <b>${smallCaps("Purchases")}:</b> ${input.purchaseCount}\n` +
    `🗓 <b>${smallCaps("Joined")}:</b> ${escapeHtml(formatDate(input.createdAt))}\n` +
    `⏱ <b>${smallCaps("Last active")}:</b> ${escapeHtml(formatDate(input.lastActiveAt))}\n` +
    `🎁 <b>${smallCaps("Bonus")}:</b> ${input.bonusAvailable ? smallCaps("Ready to claim") : escapeHtml(formatDate(input.nextBonusAt))}`;
}

export function productMessage(product: {
  emoji: string;
  name: string;
  category: string;
  description: string;
  planDetails?: string;
  warrantyHours?: number;
  featured?: boolean;
  price: number;
  stock: number;
  credits: number;
}): string {
  const stock = product.stock > 0 ? product.stock.toLocaleString("en-US") : smallCaps("Out of stock");
  const featuredBadge = product.featured ? ` 🔥` : "";
  const planLine = product.planDetails?.trim()
    ? `💎 <b>${smallCaps("Plan / Specs")}:</b> ${escapeHtml(product.planDetails.trim())}\n`
    : "";
  const warrantyHours = product.warrantyHours ?? 24;
  const warrantyLine = warrantyHours > 0
    ? `🛡 <b>${smallCaps("Warranty")}:</b> ${warrantyHours}h ${smallCaps("replacement coverage")}\n`
    : "";

  return `${escapeHtml(product.emoji)} <b>${escapeHtml(smallCaps(product.name))}</b>${featuredBadge}\n` +
    `<i>${escapeHtml(product.category)}</i>\n\n` +
    `${escapeHtml(product.description || smallCaps("A digital item, delivered securely after purchase."))}\n\n` +
    planLine +
    warrantyLine +
    `💳 <b>${smallCaps("Price")}:</b> ${creditLabel(product.price)}\n` +
    `📦 <b>${smallCaps("Stock")}:</b> ${escapeHtml(stock)}\n` +
    `💰 <b>${smallCaps("Your balance")}:</b> ${creditLabel(product.credits)}`;
}

export function renderParsedPayloadBlock(payload: string): string {
  const parsed = parseDeliveryPayload(payload);
  const lines: string[] = [];

  if (parsed.kind === "account" && parsed.login && parsed.password) {
    lines.push(`📧 <b>${smallCaps("Login / Email")}:</b> <code>${escapeHtml(parsed.login)}</code>`);
    lines.push(`🔑 <b>${smallCaps("Password")}:</b> <code>${escapeHtml(parsed.password)}</code>`);
    for (const field of parsed.extraFields) {
      const renderedVal = field.copyable
        ? `<code>${escapeHtml(field.value)}</code>`
        : escapeHtml(field.value);
      lines.push(`${field.icon} <b>${escapeHtml(smallCaps(field.label))}:</b> ${renderedVal}`);
    }
    lines.push(`\n📋 <b>${smallCaps("Full line")}:</b>\n<pre>${escapeHtml(payload)}</pre>`);
    return lines.join("\n");
  }

  if (parsed.kind === "structured" && parsed.extraFields.length > 0) {
    for (const field of parsed.extraFields) {
      const renderedVal = field.copyable
        ? `<code>${escapeHtml(field.value)}</code>`
        : escapeHtml(field.value);
      lines.push(`${field.icon} <b>${escapeHtml(smallCaps(field.label))}:</b> ${renderedVal}`);
    }
    lines.push(`\n<pre>${escapeHtml(payload)}</pre>`);
    return lines.join("\n");
  }

  if (parsed.kind === "key") {
    lines.push(`🎟 <b>${smallCaps("Key / Code")}:</b> <code>${escapeHtml(parsed.rawPayload)}</code>`);
    lines.push(`<pre>${escapeHtml(payload)}</pre>`);
    return lines.join("\n");
  }

  return `<pre>${escapeHtml(payload)}</pre>`;
}

export function purchaseDeliveryMessage(result: PurchaseResult): string {
  const qtySuffix = result.quantity && result.quantity > 1 ? ` × ${result.quantity}` : "";
  const sections: string[] = [
    `✦ <b>${smallCaps("Purchase complete")}</b>\n\n` +
      `🧾 <b>${smallCaps("Order ID")}:</b> <code>#${escapeHtml(result.purchaseId.slice(0, 8))}</code>\n` +
      `📦 <b>${smallCaps("Item")}:</b> ${escapeHtml(result.productEmoji)} ${escapeHtml(result.productName)}${qtySuffix}\n` +
      `💳 <b>${smallCaps("Paid")}:</b> ${creditLabel(result.paid)}\n` +
      `💰 <b>${smallCaps("Remaining")}:</b> ${creditLabel(result.remainingCredits)}`,
  ];

  if (result.planDetails?.trim()) {
    sections.push(`💎 <b>${smallCaps("Account / Plan details")}</b>\n${escapeHtml(result.planDetails.trim())}`);
  }

  const items = result.payloads && result.payloads.length > 1 ? result.payloads : [result.payload];
  if (items.length > 1) {
    const blocks = items.map(
      (itemPayload, idx) => `<b>#${idx + 1}</b>\n${renderParsedPayloadBlock(itemPayload)}`,
    );
    sections.push(
      `🔐 <b>${smallCaps("Your digital delivery")} (${items.length}x)</b>\n\n` +
        blocks.join("\n\n"),
    );
  } else {
    sections.push(
      `🔐 <b>${smallCaps("Your digital delivery")}</b>\n` +
        renderParsedPayloadBlock(result.payload),
    );
  }

  if (result.deliveryInstructions?.trim()) {
    sections.push(
      `📜 <b>${smallCaps("Login guide & rules")}</b>\n${escapeHtml(result.deliveryInstructions.trim())}`,
    );
  }

  const warrantyHours = result.warrantyHours ?? 0;
  if (warrantyHours > 0) {
    sections.push(
      `🛡 <b>${smallCaps("Warranty")}:</b> ${warrantyHours}h ${smallCaps("replacement coverage via My Orders")}`,
    );
  }

  sections.push(`<i>${smallCaps("Keep this private. Iris will never show this item to another user.")}</i>`);
  return sections.join("\n\n");
}

export function helpMessage(): string {
  return `ℹ️ <b>${smallCaps("Iris help")}</b>\n\n` +
    `• /store — browse enabled categories, featured items, and search\n` +
    `• /search QUERY — search products by keyword\n` +
    `• /profile — view your balance and bonus status\n` +
    `• /bonus — claim credits when your timer is ready\n` +
    `• /redeem CODE — apply a credit code\n` +
    `• /orders — open your Order Vault, download .txt receipts, or claim warranty\n\n` +
    `${smallCaps("Purchases are delivered only to the Telegram account that placed the order.")}\n` +
    `👑 <a href="https://t.me/YoriNetwork">${smallCaps("Contact the owner")}</a>`;
}
