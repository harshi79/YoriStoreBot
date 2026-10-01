import { creditLabel, escapeHtml, formatDate, safeText, smallCaps } from "../utils/format.js";
import { parseDeliveryPayload } from "../utils/credential-parser.js";
import type { InputRichBlock, InputRichBlockTable, InputRichMessage, RichBlockTableCell, RichText } from "grammy/types";
import type { PurchaseResult } from "../services/purchases.service.js";

function tableCell(text: RichText, header = false): RichBlockTableCell {
  return {
    text,
    ...(header ? { is_header: true as const } : {}),
    align: "left",
    valign: "middle",
  };
}

function keyValueTable(rows: Array<[string, RichText]>, caption: string): InputRichBlockTable {
  return {
    type: "table",
    caption,
    is_bordered: true,
    is_striped: true,
    is_compact: true,
    cells: rows.map(([label, value]) => [tableCell(label, true), tableCell(value)]),
  };
}

function dataTable(headers: string[], rows: string[][], caption: string): InputRichBlockTable {
  return {
    type: "table",
    caption,
    is_bordered: true,
    is_striped: true,
    is_compact: true,
    cells: [
      headers.map((header) => tableCell(header, true)),
      ...rows.map((row) => row.map((value) => tableCell(value))),
    ],
  };
}

function richCredentialBlocks(payload: string): InputRichBlock[] {
  const parsed = parseDeliveryPayload(payload);
  if (parsed.kind === "account" && parsed.login && parsed.password) {
    const rows: Array<[string, RichText]> = [
      ["📧 Login / email", { type: "code", text: parsed.login }],
      ["🔑 Password", { type: "code", text: parsed.password }],
      ...parsed.extraFields.map((field) => [
        `${field.icon} ${field.label}`,
        field.copyable ? { type: "code" as const, text: field.value } : field.value,
      ] as [string, RichText]),
    ];
    return [
      keyValueTable(rows, "Login details"),
      {
        type: "details",
        summary: "Show original delivery line",
        blocks: [{ type: "pre", text: payload }],
      },
    ];
  }

  if (parsed.kind === "structured" && parsed.extraFields.length > 0) {
    const rows = parsed.extraFields.map((field) => [
      `${field.icon} ${field.label}`,
      field.copyable ? { type: "code" as const, text: field.value } : field.value,
    ] as [string, RichText]);
    return [
      keyValueTable(rows, "Delivery details"),
      {
        type: "details",
        summary: "Show original delivery line",
        blocks: [{ type: "pre", text: payload }],
      },
    ];
  }

  if (parsed.kind === "key") {
    return [keyValueTable([["🎟 Key / code", { type: "code", text: parsed.rawPayload }]], "Your key")];
  }

  return [{ type: "pre", text: parsed.rawPayload || "No delivery details provided." }];
}

export function richProductMessage(product: {
  emoji: string;
  name: string;
  category: string;
  description: string;
  planDetails?: string;
  warrantyHours?: number;
  featured?: boolean;
  isUnlimited?: boolean;
  price: number;
  stock: number;
  credits: number;
}): InputRichMessage {
  const stock = product.isUnlimited
    ? "Unlimited"
    : product.stock > 0 ? product.stock.toLocaleString("en-US") : "Out of stock";
  const rows: Array<[string, RichText]> = [
    ["Price", creditLabel(product.price)],
    ["Available", stock],
    ["Your balance", creditLabel(product.credits)],
    ["Refund policy", "No refunds · all sales are final"],
  ];
  if (product.planDetails?.trim()) rows.splice(1, 0, ["Plan / specs", product.planDetails.trim()]);
  if ((product.warrantyHours ?? 24) > 0) {
    rows.splice(rows.length - 1, 0, ["Replacement window", `${product.warrantyHours ?? 24} hours`]);
  }

  return {
    blocks: [
      { type: "heading", size: 2, text: `${product.emoji} ${product.name}${product.featured ? " 🔥" : ""}` },
      { type: "paragraph", text: product.category },
      ...(product.description.trim() ? [{ type: "paragraph" as const, text: product.description.trim() }] : []),
      keyValueTable(rows, "Item details"),
    ],
  };
}

export function richPurchaseConfirmationMessage(product: {
  emoji: string;
  name: string;
  category: string;
  price: number;
  stock: number;
  credits: number;
  quantity: number;
  isUnlimited: boolean;
}): InputRichMessage {
  const total = product.price * product.quantity;
  const canAfford = product.credits >= total;
  const available = product.isUnlimited ? "Unlimited" : `${product.stock.toLocaleString("en-US")} available`;
  return {
    blocks: [
      { type: "heading", size: 2, text: "Confirm purchase" },
      { type: "paragraph", text: `${product.emoji} ${product.name} · ${product.category}` },
      keyValueTable([
        ["Unit price", creditLabel(product.price)],
        ["Quantity", `${product.quantity}`],
        ["Total", creditLabel(total)],
        ["Stock", available],
        ["Available balance", creditLabel(product.credits)],
        ["Balance after purchase", canAfford ? creditLabel(product.credits - total) : `Short by ${creditLabel(total - product.credits)}`],
        ["Policy", "No refunds · all sales are final"],
      ], "Review before buying"),
      {
        type: "footer",
        text: canAfford
          ? "Credits are charged only if the requested stock is assigned successfully."
          : `You need ${creditLabel(total - product.credits)} more to buy this item.`,
      },
    ],
  };
}

export interface PurchaseHistoryRow {
  id: string;
  amountPaid: number;
  createdAt: Date;
  product: { name: string; emoji: string };
  warrantyClaim?: { status: string } | null;
}

export function richOrderHistoryMessage(purchases: PurchaseHistoryRow[], total: number): InputRichMessage {
  const rows = purchases.map((purchase) => {
    const issueStatus = purchase.warrantyClaim?.status;
    const status = issueStatus === "PENDING" ? "Issue pending"
      : issueStatus === "REPLACED" ? "Replaced"
      : issueStatus === "REFUNDED" ? "Refunded (historical)"
      : issueStatus === "REJECTED" ? "Issue closed"
      : "Delivered";
    return [
      `${purchase.product.emoji} ${purchase.product.name}\n#${purchase.id.slice(0, 8)} · ${status}`,
      creditLabel(purchase.amountPaid),
      formatDate(purchase.createdAt),
    ];
  });
  return {
    blocks: [
      { type: "heading", size: 2, text: `Your Order Vault · ${total}` },
      { type: "paragraph", text: "Private purchase history. Open an order below to view its email, password, delivery details, or download a receipt." },
      dataTable(["Item / order", "Paid", "Purchased"], rows, "Purchase history"),
    ],
  };
}

export function richOrderDetailMessage(input: {
  purchaseId: string;
  productName: string;
  productEmoji: string;
  categoryName: string;
  amountPaid: number;
  createdAt: Date;
  warrantyStatus: string;
  payload: string;
  planDetails: string;
  deliveryInstructions: string;
}): InputRichMessage {
  const blocks: InputRichBlock[] = [
    { type: "heading", size: 2, text: `${input.productEmoji} ${input.productName}` },
    keyValueTable([
      ["Order", `#${input.purchaseId.slice(0, 8)}`],
      ["Category", input.categoryName],
      ["Paid", creditLabel(input.amountPaid)],
      ["Date", formatDate(input.createdAt)],
      ["Replacement", input.warrantyStatus],
    ], "Order summary"),
    { type: "heading", size: 3, text: "Delivered credentials & details" },
    ...richCredentialBlocks(input.payload),
  ];
  if (input.planDetails.trim()) blocks.push({ type: "paragraph", text: `Plan / specs: ${input.planDetails.trim()}` });
  if (input.deliveryInstructions.trim()) {
    blocks.push({ type: "details", summary: "Login guide & rules", blocks: [{ type: "paragraph", text: input.deliveryInstructions.trim() }] });
  }
  blocks.push({ type: "footer", text: "Keep these credentials private. Sales are final; refunds are not offered." });
  return { blocks };
}

export function richPurchaseDeliveryMessage(result: PurchaseResult): InputRichMessage {
  const items = result.payloads && result.payloads.length > 1 ? result.payloads : [result.payload];
  const blocks: InputRichBlock[] = [
    { type: "heading", size: 2, text: "Purchase complete" },
    keyValueTable([
      ["Order", `#${result.purchaseId.slice(0, 8)}`],
      ["Product", `${result.productEmoji} ${result.productName}${items.length > 1 ? ` × ${items.length}` : ""}`],
      ["Paid", creditLabel(result.paid)],
      ["Remaining balance", creditLabel(result.remainingCredits)],
    ], "Receipt"),
  ];
  for (const [index, payload] of items.entries()) {
    if (items.length > 1) blocks.push({ type: "heading", size: 3, text: `Delivery ${index + 1}` });
    blocks.push(...richCredentialBlocks(payload));
  }
  if (result.planDetails?.trim()) blocks.push({ type: "paragraph", text: `Plan / specs: ${result.planDetails.trim()}` });
  if (result.deliveryInstructions?.trim()) {
    blocks.push({ type: "details", summary: "Login guide & rules", blocks: [{ type: "paragraph", text: result.deliveryInstructions.trim() }] });
  }
  if (result.warrantyHours && result.warrantyHours > 0) {
    blocks.push({ type: "paragraph", text: `Replacement coverage: ${result.warrantyHours} hours. Report an issue from My Orders.` });
  }
  blocks.push({ type: "footer", text: "Keep these credentials private. All sales are final; refunds are not offered." });
  return { blocks };
}

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
  isUnlimited?: boolean;
  price: number;
  stock: number;
  credits: number;
}): string {
  const stock = product.isUnlimited
    ? smallCaps("Unlimited")
    : product.stock > 0 ? product.stock.toLocaleString("en-US") : smallCaps("Out of stock");
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
    `💰 <b>${smallCaps("Your balance")}:</b> ${creditLabel(product.credits)}\n\n` +
    `🚫 <b>${smallCaps("Store policy")}:</b> ${smallCaps("No refunds · all sales are final.")}`;
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

  sections.push(`<i>${smallCaps("Keep this private. Iris will never show this item to another user. All sales are final; refunds are not offered.")}</i>`);
  return sections.join("\n\n");
}

export function helpMessage(): string {
  return `ℹ️ <b>${smallCaps("Iris help")}</b>\n\n` +
    `• /store — browse enabled categories, featured items, and search\n` +
    `• /search QUERY — search products by keyword\n` +
    `• /profile — view your balance and bonus status\n` +
    `• /wallet — review your credit balance and activity history\n` +
    `• /bonus — claim credits when your timer is ready\n` +
    `• /redeem CODE — apply a credit code\n` +
    `• /orders — open your Order Vault, view your delivered credentials, download .txt receipts, or report an issue\n\n` +
    `${smallCaps("Purchases are delivered only to the Telegram account that placed the order.")}\n` +
    `${smallCaps("All sales are final. Refunds are not offered; eligible issues may be reviewed for replacement during the listed replacement window.")}\n` +
    `👑 <a href="https://t.me/YoriNetwork">${smallCaps("Contact the owner")}</a>`;
}
