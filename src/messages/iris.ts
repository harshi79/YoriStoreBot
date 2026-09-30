import { creditLabel, escapeHtml, formatDate, safeText, smallCaps } from "../utils/format.js";
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
  price: number;
  stock: number;
  credits: number;
}): string {
  const stock = product.stock > 0 ? product.stock.toLocaleString("en-US") : smallCaps("Out of stock");
  return `${escapeHtml(product.emoji)} <b>${escapeHtml(smallCaps(product.name))}</b>\n` +
    `<i>${escapeHtml(product.category)}</i>\n\n` +
    `${escapeHtml(product.description || smallCaps("A digital item, delivered securely after purchase."))}\n\n` +
    `💳 <b>${smallCaps("Price")}:</b> ${creditLabel(product.price)}\n` +
    `📦 <b>${smallCaps("Stock")}:</b> ${escapeHtml(stock)}\n` +
    `💰 <b>${smallCaps("Your balance")}:</b> ${creditLabel(product.credits)}`;
}

export function purchaseDeliveryMessage(result: PurchaseResult): string {
  return `✦ <b>${smallCaps("Purchase complete")}</b>\n\n` +
    `📦 <b>${smallCaps("Item")}:</b> ${escapeHtml(result.productEmoji)} ${escapeHtml(result.productName)}\n` +
    `💳 <b>${smallCaps("Paid")}:</b> ${creditLabel(result.paid)}\n` +
    `💰 <b>${smallCaps("Remaining")}:</b> ${creditLabel(result.remainingCredits)}\n\n` +
    `🔐 <b>${smallCaps("Your digital delivery")}</b>\n` +
    `<pre>${escapeHtml(result.payload)}</pre>\n` +
    `<i>${smallCaps("Keep this private. Iris will never show this item to another user.")}</i>`;
}

export function helpMessage(): string {
  return `ℹ️ <b>${smallCaps("Iris help")}</b>\n\n` +
    `• /store — browse enabled categories and products\n` +
    `• /profile — view your balance and bonus status\n` +
    `• /bonus — claim credits when your timer is ready\n` +
    `• /redeem CODE — apply a credit code\n` +
    `• /orders — view your purchase history\n\n` +
    `${smallCaps("Purchases are delivered only to the Telegram account that placed the order.")}\n` +
    `👑 <a href="https://t.me/YoriNetwork">${smallCaps("Contact the owner")}</a>`;
}
