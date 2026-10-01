import { InlineKeyboard } from "grammy";
import type { InputRichBlock, InputRichMessage, RichMessageButton, RichText } from "grammy/types";
import type { BotContext } from "../types/context.js";
import type { BotDependencies } from "./dependencies.js";
import {
  adminBackKeyboard,
  adminPanelKeyboard,
  categoryDetailKeyboard,
  categoryListAdminKeyboard,
  categoryProductsAdminKeyboard,
  codeListKeyboard,
  inventoryCategoriesKeyboard,
  inventoryProductsKeyboard,
  productDetailKeyboard,
  productListKeyboard,
  productPresetsKeyboard,
  userPaginationKeyboard,
} from "../keyboards/inline.js";
import { editOrReply, editOrReplyRich } from "./render.js";
import { adminPanelMessage } from "../messages/admin.js";
import {
  getAvailableInventoryItem,
  getProduct,
  listAdminProducts,
  listAvailableInventory,
  listCategories,
  listCategoryProducts,
} from "../services/store.service.js";
import { getWarrantyClaimDetail, listWarrantyClaims } from "../services/purchases.service.js";
import { listRedeemCodes } from "../services/codes.service.js";
import { listUsersPage, getStoreStatistics } from "../services/analytics.service.js";
import { renderParsedPayloadBlock, richCredentialBlocks } from "../messages/iris.js";
import {
  richButtonRow,
  richCallbackButton,
  richDataTable,
  richFooter,
  richHeading,
  richKeyValueTable,
  richParagraph,
  type RichButtonStyle,
} from "../messages/rich-ui.js";
import { creditLabel, escapeHtml, formatDate, smallCaps } from "../utils/format.js";
import { PRODUCT_DELIVERY_PRESETS } from "../utils/credential-parser.js";

const PAGE_SIZE = 8;

type RichAction = { text: string; data: string; style?: RichButtonStyle };

function actionBlock(action: RichAction): InputRichBlock {
  return richButtonRow([richCallbackButton(action.text, action.data, action.style ?? "link")]);
}

function pageButtonBlock(
  page: number,
  pages: number,
  previousData: string,
  nextData: string,
): InputRichBlock {
  return richButtonRow([
    ...(page > 0 ? [richCallbackButton("◀ Previous", previousData)] : []),
    richCallbackButton(`${page + 1}/${pages}`, "noop"),
    ...(page + 1 < pages ? [richCallbackButton("Next ▶", nextData)] : []),
  ]);
}

function richMessage(blocks: InputRichBlock[]): InputRichMessage {
  return { blocks };
}

async function showRichView(
  ctx: BotContext,
  deps: BotDependencies,
  blocks: InputRichBlock[],
  fallbackText: string,
  fallbackKeyboard: InlineKeyboard,
): Promise<void> {
  await editOrReplyRich(ctx, richMessage(blocks), fallbackText, {
    fallbackKeyboard,
    logger: deps.logger,
  });
}

function statusText(enabled: boolean): string {
  return smallCaps(enabled ? "Enabled" : "Disabled");
}

export async function showAdminPanel(ctx: BotContext, deps: BotDependencies): Promise<void> {
  const fallback = `👑 <b>${smallCaps("Iris · Owner console")}</b>\n\n` +
    `${smallCaps("Manage your catalog, stock, customers, orders, and operations from one place.")} ` +
    `${smallCaps("Reset always sends a backup and asks for two confirmations.")}`;
  await editOrReplyRich(ctx, adminPanelMessage(), fallback, {
    fallbackKeyboard: adminPanelKeyboard(),
    logger: deps.logger,
  });
}

export async function showCategoriesAdmin(ctx: BotContext, deps: BotDependencies): Promise<void> {
  const categories = await listCategories(deps.database.prisma);
  const active = categories.filter((category) => category.enabled).length;
  const rows = categories.map((category) => [
    `${category.emoji} ${category.name}`,
    statusText(category.enabled),
    category._count.products.toLocaleString("en-US"),
    (category.displayOrder + 1).toString(),
  ]);
  const fallback = `🗂 <b>${smallCaps("Categories")}</b>\n\n${categories.length} ${smallCaps("total")} · ${active} ${smallCaps("enabled")}\n` +
    `${smallCaps("Categories are created and managed here; the customer store has no hard-coded sections.")}`;
  const blocks: InputRichBlock[] = [
    richHeading("🗂 Categories", 1),
    richParagraph(`${categories.length} ${smallCaps("total")} · ${active} ${smallCaps("enabled")}. ${smallCaps("Categories are managed here; the storefront has no hard-coded sections.")}`),
    richDataTable(["Category", "Status", "Products", "Order"], rows, "Category catalog", ["left", "center", "right", "right"]),
    ...categories.map((category) => actionBlock({ text: `${category.emoji} ${category.name}`, data: `admin:category:view:${category.id}` })),
    richButtonRow([
      richCallbackButton("➕ Add category", "admin:category:add", "success"),
      richCallbackButton("◀ Admin", "admin:panel", "link"),
    ]),
  ];
  await showRichView(ctx, deps, blocks, fallback, categoryListAdminKeyboard(categories));
}

export async function showCategoryAdmin(
  ctx: BotContext,
  deps: BotDependencies,
  categoryId: string,
): Promise<void> {
  const category = await deps.database.prisma.category.findFirst({
    where: { id: categoryId, deletedAt: null },
    include: { _count: { select: { products: { where: { deletedAt: null } } } } },
  });
  if (!category) {
    await editOrReply(ctx, smallCaps("That category no longer exists."), adminBackKeyboard(), deps.logger);
    return;
  }
  const text = `${escapeHtml(category.emoji)} <b>${escapeHtml(smallCaps(category.name))}</b>\n\n` +
    `<b>${smallCaps("Description")}:</b> ${escapeHtml(category.description || smallCaps("No description"))}\n` +
    `<b>${smallCaps("Status")}:</b> ${category.enabled ? smallCaps("Enabled") : smallCaps("Disabled")}\n` +
    `<b>${smallCaps("Order")}:</b> ${category.displayOrder + 1}\n` +
    `<b>${smallCaps("Products")}:</b> ${category._count.products}`;
  const blocks: InputRichBlock[] = [
    richHeading(`${category.emoji} ${category.name}`, 1),
    richKeyValueTable([
      ["Description", category.description || smallCaps("No description")],
      ["Status", statusText(category.enabled)],
      ["Display order", (category.displayOrder + 1).toString()],
      ["Products", category._count.products.toLocaleString("en-US")],
    ], "Category record"),
    richButtonRow([
      richCallbackButton("📦 Products", `admin:category:products:${category.id}:0`, "primary"),
      richCallbackButton(category.enabled ? "⏸ Disable" : "▶ Enable", `admin:category:toggle:${category.id}`, category.enabled ? "danger" : "success"),
    ]),
    richButtonRow([
      richCallbackButton("✏️ Rename", `admin:category:rename:${category.id}`),
      richCallbackButton("📝 Description", `admin:category:description:${category.id}`),
      richCallbackButton("🎨 Icon", `admin:category:emoji:${category.id}`),
    ]),
    richButtonRow([
      richCallbackButton("⬆️ Move up", `admin:category:reorder:${category.id}:-1`),
      richCallbackButton("⬇️ Move down", `admin:category:reorder:${category.id}:1`),
      richCallbackButton("🗑 Delete", `admin:category:delete:${category.id}`, "danger"),
    ]),
    richButtonRow([richCallbackButton("◀ Categories", "admin:categories", "link")]),
  ];
  await showRichView(ctx, deps, blocks, text, categoryDetailKeyboard(category));
}

function productRows(products: Array<{
  id: string;
  name: string;
  emoji: string;
  category: { name: string };
  price: number;
  enabled: boolean;
  featured: boolean;
  _count: { inventory: number };
}>): RichText[][] {
  return products.map((product) => [
    `${product.featured ? "🔥 " : ""}${product.emoji} ${product.name}`,
    product.category.name,
    creditLabel(product.price),
    product._count.inventory.toLocaleString("en-US"),
    statusText(product.enabled),
  ]);
}

function productActionBlocks(products: Array<{ id: string; name: string; emoji: string }>, callbackPrefix = "admin:product:view:"): InputRichBlock[] {
  return products.map((product) => actionBlock({
    text: `${product.emoji} ${product.name}`,
    data: `${callbackPrefix}${product.id}`,
  }));
}

export async function showProductsAdmin(ctx: BotContext, deps: BotDependencies, page: number): Promise<void> {
  const result = await listAdminProducts(deps.database.prisma, page, PAGE_SIZE);
  const text = `📦 <b>${smallCaps("Products")}</b>\n\n${result.total} ${smallCaps("product(s) · tap one to edit details, presets, or stock.")}`;
  const blocks: InputRichBlock[] = [
    richHeading("📦 Products", 1),
    richParagraph(`${result.total} ${smallCaps("product(s) · Select an item to edit details, presets, or stock.")}`),
    richDataTable(["Product", "Category", "Price", "Stock", "Status"], productRows(result.products), "Product catalog", ["left", "left", "right", "right", "center"]),
    ...productActionBlocks(result.products),
    pageButtonBlock(page, result.pages, `admin:products:${page - 1}`, `admin:products:${page + 1}`),
    richButtonRow([
      richCallbackButton("➕ Add product", "admin:product:add", "success"),
      richCallbackButton("◀ Admin", "admin:panel", "link"),
    ]),
  ];
  await showRichView(
    ctx,
    deps,
    blocks,
    text,
    productListKeyboard(result.products, page, result.pages, "admin:panel", "admin"),
  );
}

export async function showCategoryProductsAdmin(
  ctx: BotContext,
  deps: BotDependencies,
  categoryId: string,
  page: number,
): Promise<void> {
  const category = await deps.database.prisma.category.findFirst({ where: { id: categoryId, deletedAt: null } });
  if (!category) {
    await editOrReply(ctx, smallCaps("That category no longer exists."), adminBackKeyboard(), deps.logger);
    return;
  }
  const result = await listCategoryProducts(deps.database.prisma, categoryId, page, PAGE_SIZE, true);
  const text = `${escapeHtml(category.emoji)} <b>${escapeHtml(smallCaps(category.name))} · ${smallCaps("products")}</b>\n\n${result.total} ${smallCaps("product(s).")}`;
  const rows = result.products.map((product) => [
    `${product.featured ? "🔥 " : ""}${product.emoji} ${product.name}`,
    creditLabel(product.price),
    product._count.inventory.toLocaleString("en-US"),
    statusText(product.enabled),
  ]);
  const blocks: InputRichBlock[] = [
    richHeading(`${category.emoji} ${category.name} · products`, 1),
    richParagraph(`${result.total} ${smallCaps("product(s) in this category.")}`),
    richDataTable(["Product", "Price", "Stock", "Status"], rows, "Category catalog", ["left", "right", "right", "center"]),
    ...productActionBlocks(result.products),
    pageButtonBlock(page, result.pages, `admin:category:products:${categoryId}:${page - 1}`, `admin:category:products:${categoryId}:${page + 1}`),
    richButtonRow([
      richCallbackButton("➕ Add product", `admin:product:add:${categoryId}`, "success"),
      richCallbackButton("◀ Category", `admin:category:view:${categoryId}`, "link"),
    ]),
  ];
  await showRichView(
    ctx,
    deps,
    blocks,
    text,
    categoryProductsAdminKeyboard(result.products, categoryId, page, result.pages),
  );
}

export async function showProductAdmin(ctx: BotContext, deps: BotDependencies, productId: string): Promise<void> {
  const product = await getProduct(deps.database.prisma, productId);
  const stock = product.isUnlimited && product._count.inventory > 0
    ? `∞ ${smallCaps("Unlimited")} (${product._count.inventory} ${smallCaps("template")})`
    : product._count.inventory.toLocaleString("en-US");
  const deliveryMode = product.isUnlimited ? smallCaps("Unlimited / reusable") : smallCaps("One-time stock");
  const status = `${product.enabled ? smallCaps("Enabled") : smallCaps("Disabled")}${product.featured ? ` · ${smallCaps("Featured")} 🔥` : ""}`;
  const text = `${escapeHtml(product.emoji)} <b>${escapeHtml(smallCaps(product.name))}</b>${product.featured ? " 🔥" : ""}\n\n` +
    `<b>${smallCaps("Category")}:</b> ${escapeHtml(product.category.name)}\n` +
    `<b>${smallCaps("Price")}:</b> ${creditLabel(product.price)}\n` +
    `<b>${smallCaps("Delivery mode")}:</b> ${deliveryMode}\n` +
    `<b>${smallCaps("Available stock")}:</b> ${escapeHtml(stock)}\n` +
    `<b>${smallCaps("Restock subscribers")}:</b> ${product._count.stockSubscriptions}\n` +
    `<b>${smallCaps("Warranty")}:</b> ${product.warrantyHours > 0 ? `${product.warrantyHours}h ${smallCaps("replacement")}` : smallCaps("None (0h)")}\n` +
    `<b>${smallCaps("Banner photo")}:</b> ${product.mediaFileId ? smallCaps("Attached 🖼") : smallCaps("None")}\n` +
    `<b>${smallCaps("Status")}:</b> ${status}\n\n` +
    `💎 <b>${smallCaps("Plan / Account specs")}:</b>\n${escapeHtml(product.planDetails || smallCaps("Not set (use presets or plan specs)"))}\n\n` +
    `📜 <b>${smallCaps("Login guide & rules")}:</b>\n${escapeHtml(product.deliveryInstructions || smallCaps("Not set (use presets or login guide)"))}\n\n` +
    `📝 <b>${smallCaps("Description")}:</b>\n${escapeHtml(product.description || smallCaps("No description"))}`;
  const actions: RichAction[] = [
    { text: "✏️ Name", data: `admin:product:edit:name:${product.id}` },
    { text: "📝 Description", data: `admin:product:edit:description:${product.id}` },
    { text: "💎 Plan specs", data: `admin:product:edit:plan:${product.id}` },
    { text: "📜 Login guide", data: `admin:product:edit:instructions:${product.id}` },
    { text: "⚡ Presets", data: `admin:product:presets:${product.id}`, style: "primary" },
    { text: `🛡 Warranty (${product.warrantyHours}h)`, data: `admin:product:edit:warranty:${product.id}` },
    { text: "💳 Price", data: `admin:product:edit:price:${product.id}` },
    { text: "🎨 Icon", data: `admin:product:edit:emoji:${product.id}` },
    { text: "🖼 Banner", data: `admin:product:edit:media:${product.id}` },
    { text: product.featured ? "🔥 Unfeature" : "🔥 Feature", data: `admin:product:featured:${product.id}` },
    { text: product.isUnlimited ? "♾ Unlimited: on" : "♾ Unlimited: off", data: `admin:product:unlimited:${product.id}` },
    { text: "🗂 Category", data: `admin:product:category:${product.id}` },
    { text: product.enabled ? "⏸ Disable" : "▶ Enable", data: `admin:product:toggle:${product.id}`, style: product.enabled ? "danger" : "success" },
    { text: "🧬 Clone", data: `admin:product:clone:${product.id}` },
    { text: "📥 Add stock", data: `admin:stock:add:${product.id}`, style: "primary" },
    { text: "📋 View stock", data: `admin:stock:list:${product.id}:0` },
    { text: "🗑 Delete", data: `admin:product:delete:${product.id}`, style: "danger" },
    { text: "◀ Products", data: "admin:products:0", style: "link" },
  ];
  const blocks: InputRichBlock[] = [
    richHeading(`${product.emoji} ${product.name}${product.featured ? " 🔥" : ""}`, 1),
    richKeyValueTable([
      ["Category", product.category.name],
      ["Price", creditLabel(product.price)],
      ["Delivery mode", deliveryMode],
      ["Available stock", stock],
      ["Restock subscribers", product._count.stockSubscriptions.toLocaleString("en-US")],
      ["Warranty", product.warrantyHours > 0 ? `${product.warrantyHours}h ${smallCaps("replacement")}` : smallCaps("None (0h)")],
      ["Banner photo", product.mediaFileId ? smallCaps("Attached 🖼") : smallCaps("None")],
      ["Status", status],
    ], "Product record"),
    ...(product.planDetails.trim() ? [{ type: "expandable_blockquote" as const, text: product.planDetails.trim(), credit: smallCaps("Plan / account specs") }] : []),
    ...(product.deliveryInstructions.trim() ? [{ type: "expandable_blockquote" as const, text: product.deliveryInstructions.trim(), credit: smallCaps("Login guide & rules") }] : []),
    ...(product.description.trim() ? [{ type: "expandable_blockquote" as const, text: product.description.trim(), credit: smallCaps("Description") }] : []),
    ...actions.map(actionBlock),
  ];
  await showRichView(ctx, deps, blocks, text, productDetailKeyboard(product));
}

export async function showProductPresetsAdmin(
  ctx: BotContext,
  deps: BotDependencies,
  productId: string,
): Promise<void> {
  const product = await getProduct(deps.database.prisma, productId);
  const text = `⚡ <b>${smallCaps("Delivery presets")} · ${escapeHtml(product.name)}</b>\n\n` +
    `${smallCaps("Choose a 1-click preset to automatically configure account/plan specs, 24h warranty, and buyer login rules, or customize each field manually.")}\n\n` +
    `💎 <b>${smallCaps("Current specs")}:</b> ${escapeHtml(product.planDetails || smallCaps("None"))}\n` +
    `🛡 <b>${smallCaps("Current warranty")}:</b> ${product.warrantyHours}h`;
  const blocks: InputRichBlock[] = [
    richHeading(`⚡ ${smallCaps("Delivery presets")} · ${product.name}`, 1),
    richParagraph("Choose a one-click preset for common digital goods, or customize each field manually.", true),
    richKeyValueTable([
      ["Current plan / specs", product.planDetails || smallCaps("None")],
      ["Current warranty", `${product.warrantyHours}h`],
    ], "Current setup"),
    ...Object.values(PRODUCT_DELIVERY_PRESETS).map((preset) => actionBlock({
      text: preset.buttonLabel,
      data: `admin:product:preset:${product.id}:${preset.id}`,
    })),
    richButtonRow([
      richCallbackButton("💎 Edit plan specs", `admin:product:edit:plan:${product.id}`),
      richCallbackButton("📜 Edit guide", `admin:product:edit:instructions:${product.id}`),
      richCallbackButton("◀ Product", `admin:product:view:${product.id}`, "link"),
    ]),
  ];
  await showRichView(ctx, deps, blocks, text, productPresetsKeyboard(product.id));
}

export async function showInventoryAdmin(ctx: BotContext, deps: BotDependencies): Promise<void> {
  const categories = await listCategories(deps.database.prisma);
  const fallback = `📋 <b>${smallCaps("Inventory")}</b>\n\n${smallCaps("Select a category, then a product to add, inspect, export, or clear stock.")}\n\n` +
    `${smallCaps("Supports classic email:pass or rich lines like:")}\n<code>email:pass | Plan: Mega Fan | Expiry: 2027-01-15 | Profile: #2</code>`;
  const rows = categories.map((category) => [
    `${category.emoji} ${category.name}`,
    statusText(category.enabled),
    category._count.products.toLocaleString("en-US"),
  ]);
  const blocks: InputRichBlock[] = [
    richHeading("📋 Inventory", 1),
    richParagraph("Select a category, then a product to add, inspect, export, or clear stock.", true),
    richDataTable(["Category", "Status", "Products"], rows, "Stock catalog", ["left", "center", "right"]),
    ...categories.map((category) => actionBlock({ text: `${category.emoji} ${category.name}`, data: `admin:inventory:category:${category.id}` })),
    richButtonRow([richCallbackButton("◀ Admin", "admin:panel", "link")]),
    { type: "pre", text: "email:pass | Plan: Mega Fan | Expiry: 2027-01-15 | Profile: #2" },
  ];
  await showRichView(ctx, deps, blocks, fallback, inventoryCategoriesKeyboard(categories));
}

export async function showInventoryProducts(
  ctx: BotContext,
  deps: BotDependencies,
  categoryId: string,
): Promise<void> {
  const category = await deps.database.prisma.category.findFirst({ where: { id: categoryId, deletedAt: null } });
  if (!category) {
    await editOrReply(ctx, smallCaps("That category no longer exists."), adminBackKeyboard(), deps.logger);
    return;
  }
  const result = await listCategoryProducts(deps.database.prisma, categoryId, 0, 100, true);
  const text = `${escapeHtml(category.name)} ${smallCaps("inventory")}\n\n${smallCaps("Choose a product to inspect or add stock.")}`;
  const rows = result.products.map((product) => [
    `${product.emoji} ${product.name}`,
    creditLabel(product.price),
    product._count.inventory.toLocaleString("en-US"),
    statusText(product.enabled),
  ]);
  const blocks: InputRichBlock[] = [
    richHeading(`📋 ${category.name} inventory`, 1),
    richParagraph("Choose a product to inspect or add stock.", true),
    richDataTable(["Product", "Price", "Available", "Status"], rows, "Category stock", ["left", "right", "right", "center"]),
    ...result.products.map((product) => actionBlock({
      text: `${product.emoji} ${product.name}`,
      data: `admin:stock:product:${product.id}`,
    })),
    richButtonRow([richCallbackButton("◀ Category", `admin:inventory:category:${categoryId}`, "link")]),
  ];
  await showRichView(ctx, deps, blocks, text, inventoryProductsKeyboard(result.products, categoryId));
}

export async function showInventoryList(
  ctx: BotContext,
  deps: BotDependencies,
  productId: string,
  page: number,
): Promise<void> {
  const product = await getProduct(deps.database.prisma, productId);
  const [items, total] = await Promise.all([
    listAvailableInventory(deps.database.prisma, productId, page * PAGE_SIZE, PAGE_SIZE),
    deps.database.prisma.inventoryItem.count({ where: { productId, status: "AVAILABLE" } }),
  ]);
  const keyboard = new InlineKeyboard();
  for (const item of items) {
    keyboard
      .text(`👁 ${item.id.slice(0, 8)} · ${formatDate(item.createdAt)}`.slice(0, 46), `admin:stock:peek:${item.id}`)
      .text(smallCaps("🗑"), `admin:stock:remove:${item.id}`)
      .row();
  }
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (page > 0) keyboard.text(smallCaps("◀"), `admin:stock:list:${productId}:${page - 1}`);
  keyboard.text(smallCaps(`${page + 1}/${pages}`), "noop");
  if (page + 1 < pages) keyboard.text(smallCaps("▶"), `admin:stock:list:${productId}:${page + 1}`);
  keyboard.row()
    .text(smallCaps("➕ ADD STOCK"), `admin:stock:add:${productId}`)
    .text(smallCaps("📤 EXPORT .TXT"), `admin:stock:export:${productId}`);
  if (total > 0) keyboard.row().text(smallCaps("🧹 CLEAR ALL STOCK"), `admin:stock:clear:${productId}`);
  keyboard.row().text(smallCaps("◀ PRODUCT"), `admin:product:view:${productId}`);
  const fallback = items.length
    ? `📋 <b>${escapeHtml(smallCaps(product.name))} · ${smallCaps("available items")}</b>\n\n${total} ${smallCaps("item(s). Tap view on an item to inspect its credentials/details, or remove it.")}\n\n` +
      `${items.map((item) => `• <code>${item.id.slice(0, 8)}</code> · ${escapeHtml(formatDate(item.createdAt))}`).join("\n")}`
    : `📋 <b>${escapeHtml(smallCaps(product.name))} · ${smallCaps("inventory")}</b>\n\n${smallCaps("No available items. Add authorized stock to make this product purchasable.")}`;
  const rows = items.map((item) => [
    `#${item.id.slice(0, 8)}`,
    formatDate(item.createdAt),
    smallCaps("Available"),
  ]);
  const blocks: InputRichBlock[] = [
    richHeading(`📋 ${product.name} · inventory`, 1),
    richParagraph(`${total} ${smallCaps("available item(s). Choose an item to inspect, or manage stock below.")}`),
    richDataTable(["Stock item", "Added", "Status"], rows, "Available inventory", ["left", "left", "center"]),
    ...items.map((item) => richButtonRow([
      richCallbackButton(`👁 Inspect #${item.id.slice(0, 8)}`, `admin:stock:peek:${item.id}`),
      richCallbackButton("🗑 Remove", `admin:stock:remove:${item.id}`, "danger"),
    ])),
    ...(pages > 1 ? [pageButtonBlock(page, pages, `admin:stock:list:${productId}:${page - 1}`, `admin:stock:list:${productId}:${page + 1}`)] : []),
    richButtonRow([
      richCallbackButton("➕ Add stock", `admin:stock:add:${productId}`, "success"),
      richCallbackButton("📤 Export .txt", `admin:stock:export:${productId}`),
    ]),
    ...(total > 0 ? [richButtonRow([richCallbackButton("🧹 Clear all stock", `admin:stock:clear:${productId}`, "danger")])] : []),
    richButtonRow([richCallbackButton("◀ Product", `admin:product:view:${productId}`, "link")]),
  ];
  await showRichView(ctx, deps, blocks, fallback, keyboard);
}

export async function showInventoryItemPeek(
  ctx: BotContext,
  deps: BotDependencies,
  itemId: string,
): Promise<void> {
  const item = await getAvailableInventoryItem(deps.database.prisma, itemId);
  const keyboard = new InlineKeyboard()
    .text(smallCaps("🗑 REMOVE THIS ITEM"), `admin:stock:remove:${item.id}`)
    .row()
    .text(smallCaps("◀ BACK TO STOCK LIST"), `admin:stock:list:${item.productId}:0`);
  const text = `👁 <b>${smallCaps("Stock item inspector")}</b>\n\n` +
    `<b>${smallCaps("Product")}:</b> ${escapeHtml(item.product.emoji)} ${escapeHtml(item.product.name)}\n` +
    `<b>${smallCaps("Item ID")}:</b> <code>${escapeHtml(item.id.slice(0, 8))}</code>\n` +
    `<b>${smallCaps("Added")}:</b> ${escapeHtml(formatDate(item.createdAt))}\n\n` +
    `<b>${smallCaps("Parsed buyer preview")}:</b>\n${renderParsedPayloadBlock(item.payload)}`;
  const blocks: InputRichBlock[] = [
    richHeading("👁 Stock item inspector", 1),
    richKeyValueTable([
      ["Product", `${item.product.emoji} ${item.product.name}`],
      ["Item ID", { type: "code", text: item.id.slice(0, 8) }],
      ["Added", formatDate(item.createdAt)],
    ], "Stock record"),
    ...richCredentialBlocks(item.payload),
    richButtonRow([
      richCallbackButton("🗑 Remove this item", `admin:stock:remove:${item.id}`, "danger"),
      richCallbackButton("◀ Back to stock list", `admin:stock:list:${item.productId}:0`, "link"),
    ]),
  ];
  await showRichView(ctx, deps, blocks, text, keyboard);
}

export async function showWarrantyClaimsAdmin(
  ctx: BotContext,
  deps: BotDependencies,
  page: number,
): Promise<void> {
  const result = await listWarrantyClaims(deps.database.prisma, page, PAGE_SIZE);
  const keyboard = new InlineKeyboard();
  for (const claim of result.claims) {
    const icon = claim.status === "PENDING" ? "⏳"
      : claim.status === "REPLACED" ? "🔄"
      : claim.status === "REFUNDED" ? "💳"
      : "❌";
    const buyerLabel = claim.buyer.username ? `@${claim.buyer.username}` : claim.buyer.firstName ?? "Buyer";
    keyboard.text(`${icon} ${claim.product.name} · ${buyerLabel}`.slice(0, 58), `admin:warranty:view:${claim.id}`).row();
  }
  if (page > 0) keyboard.text(smallCaps("◀"), `admin:warranty:${page - 1}`);
  keyboard.text(smallCaps(`${page + 1}/${result.pages}`), "noop");
  if (page + 1 < result.pages) keyboard.text(smallCaps("▶"), `admin:warranty:${page + 1}`);
  keyboard.row().text(smallCaps("◀ ADMIN"), "admin:panel");

  const lines = result.claims.map((claim) => {
    const buyerLabel = claim.buyer.username
      ? `@${escapeHtml(claim.buyer.username)}`
      : `ID <code>${claim.buyer.telegramId.toString()}</code>`;
    return `• <b>[${smallCaps(claim.status)}]</b> ${escapeHtml(claim.product.emoji)} ${escapeHtml(smallCaps(claim.product.name))} · ${buyerLabel}\n  ${smallCaps("Reason")}: <i>${escapeHtml(claim.reason)}</i>`;
  });
  const fallback = `🛡 <b>${smallCaps("Warranty & replacement claims")}</b>\n\n` +
    `${result.pendingCount} ${smallCaps("pending")} · ${result.total} ${smallCaps("total")}\n\n` +
    `${lines.join("\n\n") || smallCaps("No warranty claims submitted yet.")}`;
  const rows = result.claims.map((claim) => [
    `${claim.product.emoji} ${claim.product.name}`,
    claim.buyer.username ? `@${claim.buyer.username}` : claim.buyer.telegramId.toString(),
    smallCaps(claim.status),
    formatDate(claim.createdAt),
  ]);
  const blocks: InputRichBlock[] = [
    richHeading("🛡 Warranty & replacement claims", 1),
    richParagraph(`${result.pendingCount} ${smallCaps("pending")} · ${result.total} ${smallCaps("total")}`),
    richDataTable(["Product", "Buyer", "Status", "Submitted"], rows, "Warranty queue", ["left", "left", "center", "right"]),
    ...result.claims.map((claim) => actionBlock({
      text: `${claim.status === "PENDING" ? "⏳" : "🛡"} ${claim.product.name}`,
      data: `admin:warranty:view:${claim.id}`,
    })),
    ...(result.pages > 1 ? [pageButtonBlock(page, result.pages, `admin:warranty:${page - 1}`, `admin:warranty:${page + 1}`)] : []),
    richButtonRow([richCallbackButton("◀ Admin", "admin:panel", "link")]),
  ];
  await showRichView(ctx, deps, blocks, fallback, keyboard);
}

export async function showWarrantyClaimDetail(
  ctx: BotContext,
  deps: BotDependencies,
  claimId: string,
): Promise<void> {
  const claim = await getWarrantyClaimDetail(deps.database.prisma, claimId);
  const buyerLabel = claim.buyer.username
    ? `@${escapeHtml(claim.buyer.username)} (<code>${claim.buyer.telegramId.toString()}</code>)`
    : `<code>${claim.buyer.telegramId.toString()}</code>`;
  const keyboard = new InlineKeyboard();
  const actionRows: RichMessageButton[][] = [];
  if (claim.status === "PENDING") {
    keyboard
      .text(smallCaps("🔄 REPLACE FROM STOCK"), `admin:warranty:replace:${claim.id}`)
      .row()
      .text(smallCaps("❌ REJECT ISSUE"), `admin:warranty:reject:${claim.id}`)
      .row();
    actionRows.push([
      richCallbackButton("🔄 Replace from stock", `admin:warranty:replace:${claim.id}`, "success"),
      richCallbackButton("❌ Reject issue", `admin:warranty:reject:${claim.id}`, "danger"),
    ]);
  }
  keyboard.text(smallCaps("◀ WARRANTY CLAIMS"), "admin:warranty:0");
  actionRows.push([richCallbackButton("◀ Warranty claims", "admin:warranty:0", "link")]);

  const text = `🛡 <b>${smallCaps("Warranty claim")}</b> · <code>#${escapeHtml(claim.id.slice(0, 8))}</code>\n\n` +
    `<b>${smallCaps("Status")}:</b> ${smallCaps(claim.status)}\n` +
    `<b>${smallCaps("Buyer")}:</b> ${buyerLabel}\n` +
    `<b>${smallCaps("Product")}:</b> ${escapeHtml(claim.product.emoji)} ${escapeHtml(smallCaps(claim.product.name))}\n` +
    `<b>${smallCaps("Order ID")}:</b> <code>#${escapeHtml(claim.purchaseId.slice(0, 8))}</code> (${creditLabel(claim.purchase.amountPaid)})\n` +
    `<b>${smallCaps("Submitted")}:</b> ${escapeHtml(formatDate(claim.createdAt))}\n` +
    `<b>${smallCaps("Reported issue")}:</b> ${escapeHtml(claim.reason)}\n` +
    (claim.resolutionNote ? `<b>${smallCaps("Resolution")}:</b> ${escapeHtml(claim.resolutionNote)}\n` : "") +
    `\n<b>${smallCaps("Current delivered item")}:</b>\n${renderParsedPayloadBlock(claim.purchase.inventoryItem.payload)}\n\n` +
    `<i>${smallCaps("Refunds are not offered. Pending claims can only be replaced from available stock or rejected.")}</i>`;
  const blocks: InputRichBlock[] = [
    richHeading(`🛡 Warranty claim · #${claim.id.slice(0, 8)}`, 1),
    richKeyValueTable([
      ["Status", smallCaps(claim.status)],
      ["Buyer", claim.buyer.username ? `@${claim.buyer.username} · ${claim.buyer.telegramId}` : claim.buyer.telegramId.toString()],
      ["Product", `${claim.product.emoji} ${claim.product.name}`],
      ["Order", `#${claim.purchaseId.slice(0, 8)}`],
      ["Paid", creditLabel(claim.purchase.amountPaid)],
      ["Submitted", formatDate(claim.createdAt)],
      ...(claim.resolutionNote ? [["Resolution", claim.resolutionNote] as [string, RichText]] : []),
    ], "Claim record"),
    { type: "expandable_blockquote", text: claim.reason, credit: smallCaps("Reported issue") },
    richHeading("Current delivered item", 3),
    ...richCredentialBlocks(claim.purchase.inventoryItem.payload),
    richParagraph("Refunds are not offered. Pending claims can be replaced from available stock or rejected.", true),
    ...actionRows.map((buttons) => richButtonRow(buttons)),
  ];
  await showRichView(ctx, deps, blocks, text, keyboard);
}

export async function showUsersAdmin(ctx: BotContext, deps: BotDependencies, page: number): Promise<void> {
  const result = await listUsersPage(deps.database.prisma, page, PAGE_SIZE);
  const keyboard = userPaginationKeyboard(page, result.pages);
  for (const user of result.users) {
    keyboard.row().text(
      `${user.username ? `@${user.username}` : user.firstName ?? "User"} · ${user.credits}c`.slice(0, 60),
      `admin:user:${user.id}`,
    );
  }
  const lines = result.users.map((user) =>
    `• ${user.username ? `@${escapeHtml(user.username)}` : escapeHtml(user.firstName ?? "User")} · <code>${user.telegramId.toString()}</code> · ${user.credits}c\n  ${smallCaps("Active")} ${escapeHtml(formatDate(user.lastActiveAt))} · ${smallCaps("Joined")} ${escapeHtml(formatDate(user.createdAt))}`,
  );
  const fallback = `👥 <b>${smallCaps("Users")}</b> · ${result.total}\n\n${lines.join("\n\n") || smallCaps("No users yet.")}`;
  const rows = result.users.map((user) => [
    user.username ? `@${user.username}` : user.firstName ?? "User",
    user.telegramId.toString(),
    creditLabel(user.credits),
    formatDate(user.lastActiveAt),
  ]);
  const blocks: InputRichBlock[] = [
    richHeading(`👥 Users · ${result.total}`, 1),
    richParagraph("Latest active customers and account balances.", true),
    richDataTable(["Customer", "Telegram ID", "Balance", "Last active"], rows, "Customer accounts", ["left", "right", "right", "right"]),
    ...result.users.map((user) => actionBlock({
      text: `${user.username ? `@${user.username}` : user.firstName ?? "User"} · ${creditLabel(user.credits)}`,
      data: `admin:user:${user.id}`,
    })),
    pageButtonBlock(page, result.pages, `admin:users:${page - 1}`, `admin:users:${page + 1}`),
  ];
  await showRichView(ctx, deps, blocks, fallback, keyboard);
}

export async function showUserDetail(ctx: BotContext, deps: BotDependencies, userId: string): Promise<void> {
  const user = await deps.database.prisma.user.findUnique({
    where: { id: userId },
    include: { _count: { select: { purchases: true, creditTransactions: true } } },
  });
  if (!user) {
    await editOrReply(ctx, smallCaps("That user no longer exists."), adminBackKeyboard(), deps.logger);
    return;
  }
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ") || "Iris user";
  const text = `👤 <b>${escapeHtml(smallCaps(name))}</b>\n\n` +
    `<b>${smallCaps("Username")}:</b> ${user.username ? `@${escapeHtml(user.username)}` : smallCaps("Not set")}\n` +
    `<b>${smallCaps("Telegram ID")}:</b> <code>${user.telegramId.toString()}</code>\n` +
    `<b>${smallCaps("Credits")}:</b> ${creditLabel(user.credits)}\n` +
    `<b>${smallCaps("Purchases")}:</b> ${user._count.purchases}\n` +
    `<b>${smallCaps("Transactions")}:</b> ${user._count.creditTransactions}\n` +
    `<b>${smallCaps("Joined")}:</b> ${escapeHtml(formatDate(user.createdAt))}\n` +
    `<b>${smallCaps("Last active")}:</b> ${escapeHtml(formatDate(user.lastActiveAt))}`;
  const keyboard = new InlineKeyboard()
    .text(smallCaps("🎁 GIFT 10"), `admin:user:gift:${user.id}:10`)
    .text(smallCaps("−10"), `admin:user:remove:${user.id}:10`)
    .row()
    .text(smallCaps("◀ USERS"), "admin:users:0");
  const blocks: InputRichBlock[] = [
    richHeading(`👤 ${name}`, 1),
    richKeyValueTable([
      ["Username", user.username ? `@${user.username}` : smallCaps("Not set")],
      ["Telegram ID", { type: "code", text: user.telegramId.toString() }],
      ["Credits", creditLabel(user.credits)],
      ["Purchases", user._count.purchases.toLocaleString("en-US")],
      ["Transactions", user._count.creditTransactions.toLocaleString("en-US")],
      ["Joined", formatDate(user.createdAt)],
      ["Last active", formatDate(user.lastActiveAt)],
    ], "Customer record"),
    richButtonRow([
      richCallbackButton("🎁 Gift 10", `admin:user:gift:${user.id}:10`, "success"),
      richCallbackButton("−10", `admin:user:remove:${user.id}:10`, "danger"),
      richCallbackButton("◀ Users", "admin:users:0", "link"),
    ]),
  ];
  await showRichView(ctx, deps, blocks, text, keyboard);
}

export async function showCodesAdmin(ctx: BotContext, deps: BotDependencies, page: number): Promise<void> {
  const [codes, total] = await Promise.all([
    listRedeemCodes(deps.database.prisma, page * PAGE_SIZE, PAGE_SIZE),
    deps.database.prisma.redeemCode.count(),
  ]);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const keyboard = codeListKeyboard(codes, page, pages);
  const rows = codes.map((code) => [
    code.code,
    creditLabel(code.creditAmount),
    `${code.currentRedeems}/${code.maxRedeems}`,
    statusText(code.enabled),
    formatDate(code.expiresAt),
  ]);
  const fallback = `🔑 <b>${smallCaps("Redeem codes")}</b> · ${total}\n\n${smallCaps("Use /code AMOUNT CREDITS MAXREDEEMS to create a batch.")}`;
  const blocks: InputRichBlock[] = [
    richHeading(`🔑 Redeem codes · ${total}`, 1),
    richParagraph("Create codes with /code AMOUNT CREDITS MAXREDEEMS.", true),
    richDataTable(["Code", "Credits", "Redemptions", "Status", "Expires"], rows, "Code inventory", ["left", "right", "center", "center", "right"]),
    ...codes.map((code) => richButtonRow([
      richCallbackButton(`${code.enabled ? "🟢" : "⚪"} ${code.code}`, `admin:code:view:${code.id}`, "link", false),
    ])),
    pageButtonBlock(page, pages, `admin:codes:${page - 1}`, `admin:codes:${page + 1}`),
    richButtonRow([richCallbackButton("◀ Admin", "admin:panel", "link")]),
  ];
  await showRichView(ctx, deps, blocks, fallback, keyboard);
}

export async function showCodeDetail(ctx: BotContext, deps: BotDependencies, codeId: string): Promise<void> {
  const code = await deps.database.prisma.redeemCode.findUnique({
    where: { id: codeId },
    include: { _count: { select: { redemptions: true } } },
  });
  if (!code) {
    await editOrReply(ctx, smallCaps("That code no longer exists."), adminBackKeyboard(), deps.logger);
    return;
  }
  const keyboard = new InlineKeyboard()
    .text(smallCaps(code.enabled ? "⏸ DISABLE" : "▶ ENABLE"), `admin:code:toggle:${code.id}`)
    .row()
    .text(smallCaps("◀ CODES"), "admin:codes:0");
  const text = `🔑 <b>${escapeHtml(code.code)}</b>\n\n` +
    `<b>${smallCaps("Credits per redemption")}:</b> ${creditLabel(code.creditAmount)}\n` +
    `<b>${smallCaps("Redemptions")}:</b> ${code.currentRedeems}/${code.maxRedeems}\n` +
    `<b>${smallCaps("Status")}:</b> ${code.enabled ? smallCaps("Enabled") : smallCaps("Disabled")}\n` +
    `<b>${smallCaps("Expires")}:</b> ${escapeHtml(formatDate(code.expiresAt))}\n` +
    `<b>${smallCaps("Recorded redemptions")}:</b> ${code._count.redemptions}`;
  const blocks: InputRichBlock[] = [
    richHeading([smallCaps("🔑 "), { type: "code", text: code.code }], 1),
    richKeyValueTable([
      ["Credits per redemption", creditLabel(code.creditAmount)],
      ["Redemptions", `${code.currentRedeems}/${code.maxRedeems}`],
      ["Status", statusText(code.enabled)],
      ["Expires", formatDate(code.expiresAt)],
      ["Recorded redemptions", code._count.redemptions.toLocaleString("en-US")],
    ], "Redeem code record"),
    richButtonRow([
      richCallbackButton(code.enabled ? "⏸ Disable" : "▶ Enable", `admin:code:toggle:${code.id}`, code.enabled ? "danger" : "success"),
      richCallbackButton("◀ Codes", "admin:codes:0", "link"),
    ]),
  ];
  await showRichView(ctx, deps, blocks, text, keyboard);
}

export async function showStatistics(ctx: BotContext, deps: BotDependencies): Promise<void> {
  const stats = await getStoreStatistics(deps.database.prisma);
  const recent = stats.recentPurchases.map((purchase) => [
    `${purchase.product.emoji} ${purchase.product.name}`,
    creditLabel(purchase.amountPaid),
    purchase.buyer.username ? `@${purchase.buyer.username}` : purchase.buyer.telegramId.toString(),
    formatDate(purchase.createdAt),
  ]);
  const recentLines = stats.recentPurchases.map((purchase) =>
    `• ${escapeHtml(purchase.product.emoji)} ${escapeHtml(smallCaps(purchase.product.name))} — ${creditLabel(purchase.amountPaid)} · ` +
    `${purchase.buyer.username ? `@${escapeHtml(purchase.buyer.username)}` : `ID ${purchase.buyer.telegramId.toString()}`} · ${escapeHtml(formatDate(purchase.createdAt))}`,
  );
  const text = `📊 <b>${smallCaps("Store statistics")}</b>\n\n` +
    `👥 ${smallCaps("Users")}: ${stats.users}\n` +
    `🟢 ${smallCaps("Active 24h")}: ${stats.active24h}\n` +
    `🟢 ${smallCaps("Active 72h")}: ${stats.active72h}\n` +
    `📦 ${smallCaps("Products")}: ${stats.products}\n` +
    `📋 ${smallCaps("Available inventory")}: ${stats.inventory}\n` +
    `🧾 ${smallCaps("Purchases")}: ${stats.purchases}\n` +
    `✦ ${smallCaps("Credits issued (net)")}: ${stats.creditsIssued.toLocaleString("en-US")}\n` +
    `💳 ${smallCaps("Spent / revenue-equivalent")}: ${stats.creditsSpent.toLocaleString("en-US")} ${smallCaps("credits")}\n\n` +
    `<b>${smallCaps("Recent purchases")}</b>\n${recentLines.join("\n") || smallCaps("None yet.")}`;
  const blocks: InputRichBlock[] = [
    richHeading("📊 Store statistics", 1),
    richKeyValueTable([
      ["Users", stats.users.toLocaleString("en-US")],
      ["Active · 24 hours", stats.active24h.toLocaleString("en-US")],
      ["Active · 72 hours", stats.active72h.toLocaleString("en-US")],
      ["Products", stats.products.toLocaleString("en-US")],
      ["Available inventory", stats.inventory.toLocaleString("en-US")],
      ["Purchases", stats.purchases.toLocaleString("en-US")],
      ["Credits issued (net)", stats.creditsIssued.toLocaleString("en-US")],
      ["Credits spent / revenue-equivalent", `${stats.creditsSpent.toLocaleString("en-US")} ${smallCaps("credits")}`],
    ], "Store performance"),
    richDataTable(["Product", "Paid", "Buyer", "Purchased"], recent, "Recent purchases", ["left", "right", "left", "right"]),
    richButtonRow([
      richCallbackButton("👥 Users", "admin:users:0"),
      richCallbackButton("🧾 Purchases", "admin:purchases:0"),
      richCallbackButton("◀ Admin", "admin:panel", "link"),
    ]),
  ];
  await showRichView(
    ctx,
    deps,
    blocks,
    text,
    new InlineKeyboard().text(smallCaps("👥 USERS"), "admin:users:0").text(smallCaps("🧾 PURCHASES"), "admin:purchases:0").row().text(smallCaps("◀ ADMIN"), "admin:panel"),
  );
}

export async function showPurchasesAdmin(ctx: BotContext, deps: BotDependencies, page: number): Promise<void> {
  const skip = Math.max(0, page) * PAGE_SIZE;
  const [purchases, total] = await Promise.all([
    deps.database.prisma.purchase.findMany({
      orderBy: { createdAt: "desc" },
      skip,
      take: PAGE_SIZE,
      include: {
        buyer: { select: { telegramId: true, username: true } },
        product: { select: { name: true, emoji: true } },
      },
    }),
    deps.database.prisma.purchase.count(),
  ]);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const keyboard = new InlineKeyboard();
  if (page > 0) keyboard.text(smallCaps("◀"), `admin:purchases:${page - 1}`);
  keyboard.text(smallCaps(`${page + 1}/${pages}`), "noop");
  if (page + 1 < pages) keyboard.text(smallCaps("▶"), `admin:purchases:${page + 1}`);
  keyboard.row().text(smallCaps("◀ ADMIN"), "admin:panel");
  const lines = purchases.map((purchase) =>
    `• ${escapeHtml(purchase.product.emoji)} ${escapeHtml(smallCaps(purchase.product.name))} · ${creditLabel(purchase.amountPaid)}\n  ${purchase.buyer.username ? `@${escapeHtml(purchase.buyer.username)}` : `ID ${purchase.buyer.telegramId.toString()}`} · ${escapeHtml(formatDate(purchase.createdAt))}`,
  );
  const text = `🧾 <b>${smallCaps("Purchases")}</b> · ${total}\n\n${lines.join("\n\n") || smallCaps("No purchases yet.")}`;
  const rows = purchases.map((purchase) => [
    `${purchase.product.emoji} ${purchase.product.name}`,
    creditLabel(purchase.amountPaid),
    purchase.buyer.username ? `@${purchase.buyer.username}` : purchase.buyer.telegramId.toString(),
    formatDate(purchase.createdAt),
  ]);
  const blocks: InputRichBlock[] = [
    richHeading(`🧾 Purchases · ${total}`, 1),
    richDataTable(["Product", "Paid", "Buyer", "Date"], rows, "Purchase ledger", ["left", "right", "left", "right"]),
    ...(pages > 1 ? [pageButtonBlock(page, pages, `admin:purchases:${page - 1}`, `admin:purchases:${page + 1}`)] : []),
    richButtonRow([richCallbackButton("◀ Admin", "admin:panel", "link")]),
  ];
  await showRichView(ctx, deps, blocks, text, keyboard);
}

export async function showCreditsManagement(ctx: BotContext, deps: BotDependencies): Promise<void> {
  const commands = [
    ["/gift USER_ID CREDITS", smallCaps("Add credits to one customer.")],
    ["/rm USER_ID CREDITS", smallCaps("Remove credits from one customer.")],
    ["/giftall CREDITS", smallCaps("Gift credits to users active in the last 72 hours.")],
    ["/code AMOUNT CREDITS MAXREDEEMS", smallCaps("Create a redeem-code batch.")],
  ];
  const text = `🎁 <b>${smallCaps("Credit management")}</b>\n\n` +
    `${commands.map(([command, description]) => `• ${command} — ${description}`).join("\n")}\n\n` +
    `${smallCaps("Every balance change is written to the credit ledger.")}`;
  const blocks: InputRichBlock[] = [
    richHeading("🎁 Credit management", 1),
    richDataTable(["Command", "Use"], commands, "Owner commands", ["left", "left"]),
    richFooter("Every balance change is written to the credit ledger.", true),
    richButtonRow([richCallbackButton("◀ Admin", "admin:panel", "link")]),
  ];
  await showRichView(ctx, deps, blocks, text, adminBackKeyboard());
}

export async function showSettings(ctx: BotContext, deps: BotDependencies): Promise<void> {
  const settings = await deps.database.prisma.appSetting.findMany({ orderBy: { key: "asc" } });
  const bonus = await import("../services/settings.service.js").then(({ getBonusSettings }) =>
    getBonusSettings(deps.database.prisma, {
      credits: deps.config.bonusCredits,
      periodHours: deps.config.bonusPeriodHours,
    }),
  );
  const stored = settings.length ? settings.map((item) => `${escapeHtml(item.key)}: ${escapeHtml(item.value)}`).join("\n") : smallCaps("No custom settings.");
  const text = `⚙️ <b>${smallCaps("Settings")}</b>\n\n` +
    `<b>${smallCaps("Owner ID")}:</b> <code>${deps.config.ownerId.toString()}</code>\n` +
    `<b>${smallCaps("Daily bonus")}:</b> ${creditLabel(bonus.credits)} ${smallCaps("every")} ${bonus.periodHours}h\n` +
    `<b>${smallCaps("Bonus configuration")}:</b> ${smallCaps("Environment defaults with owner overrides")}\n\n` +
    `<b>${smallCaps("Stored settings")}</b>\n${stored}`;
  const blocks: InputRichBlock[] = [
    richHeading("⚙️ Settings", 1),
    richKeyValueTable([
      ["Owner ID", { type: "code", text: deps.config.ownerId.toString() }],
      ["Daily bonus", `${creditLabel(bonus.credits)} ${smallCaps("every")} ${bonus.periodHours}h`],
      ["Bonus configuration", smallCaps("Environment defaults with owner overrides")],
    ], "Runtime settings"),
    richDataTable(
      ["Setting", "Value"],
      settings.map((item) => [item.key, item.value]),
      "Stored overrides",
    ),
    richButtonRow([
      richCallbackButton("🎁 Edit bonus settings", "admin:settings:bonus", "primary"),
      richCallbackButton("◀ Admin", "admin:panel", "link"),
    ]),
  ];
  if (settings.length === 0) blocks.splice(2, 0, richParagraph("No custom settings are stored.", true));
  await showRichView(
    ctx,
    deps,
    blocks,
    text,
    new InlineKeyboard().text(smallCaps("🎁 EDIT BONUS SETTINGS"), "admin:settings:bonus").row().text(smallCaps("◀ ADMIN"), "admin:panel"),
  );
}

export function getCodePages(total: number): number {
  return Math.max(1, Math.ceil(total / PAGE_SIZE));
}
