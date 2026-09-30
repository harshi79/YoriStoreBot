import { InlineKeyboard } from "grammy";
import type { Category, Product, RedeemCode } from "../generated/prisma/client.js";

export function mainKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🛍 STORE", "nav:store")
    .text("👤 PROFILE", "nav:profile")
    .row()
    .text("🎁 BONUS", "nav:bonus")
    .text("📦 MY ORDERS", "nav:orders")
    .row()
    .text("ℹ️ HELP", "nav:help")
    .url("👑 OWNER", "https://t.me/YoriNetwork");
}

export function profileKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🛍 STORE", "nav:store")
    .text("🎁 BONUS", "nav:bonus")
    .row()
    .text("📦 ORDERS", "nav:orders")
    .text("◀ BACK", "nav:home");
}

export function backHomeKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("◀ BACK", "nav:home");
}

export function categoriesKeyboard(categories: Array<Category & { _count: { products: number } }>): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const category of categories) {
    keyboard.text(
      `${category.emoji} ${category.name} · ${category._count.products}`,
      `store:category:${category.id}:0`,
    ).row();
  }
  return keyboard.text("◀ HOME", "nav:home");
}

export function storeCategoryProductsKeyboard(
  products: Array<Product & { category: Category; _count: { inventory: number } }>,
  categoryId: string,
  page: number,
  totalPages: number,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const product of products) {
    const status = product._count.inventory > 0 ? "" : " · OUT OF STOCK";
    keyboard.text(
      `${product.emoji} ${product.name} · ${product.price} credits${status}`.slice(0, 58),
      `store:product:${product.id}`,
    ).row();
  }
  if (page > 0) keyboard.text("◀", `store:category:${categoryId}:${page - 1}`);
  keyboard.text(`${page + 1}/${totalPages}`, "noop");
  if (page + 1 < totalPages) keyboard.text("▶", `store:category:${categoryId}:${page + 1}`);
  keyboard.row().text("◀ CATEGORIES", "nav:store").text("🏠 HOME", "nav:home");
  return keyboard;
}

export function productListKeyboard(
  products: Array<Product & { category: Category; _count: { inventory: number } }>,
  page: number,
  totalPages: number,
  backData: string,
  namespace: "store" | "admin",
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const product of products) {
    const status = product.enabled && product._count.inventory > 0 ? "" : " · OUT";
    const prefix = namespace === "store" ? "store:product:" : "admin:product:view:";
    keyboard.text(
      `${product.emoji} ${product.name} · ${product.price}c${status}`.slice(0, 58),
      `${prefix}${product.id}`,
    ).row();
  }
  const previous = page > 0;
  const next = page + 1 < totalPages;
  if (previous || next) {
    if (previous) keyboard.text("◀", `${namespace}:products:${page - 1}`);
    keyboard.text(`${page + 1}/${totalPages}`, "noop");
    if (next) keyboard.text("▶", `${namespace}:products:${page + 1}`);
    keyboard.row();
  }
  keyboard.text("◀ BACK", backData).text("🏠 HOME", "nav:home");
  return keyboard;
}

export function categoryDetailKeyboard(category: Category): InlineKeyboard {
  return new InlineKeyboard()
    .text("📦 PRODUCTS", `admin:category:products:${category.id}:0`)
    .text(category.enabled ? "⏸ DISABLE" : "▶ ENABLE", `admin:category:toggle:${category.id}`)
    .row()
    .text("✏️ RENAME", `admin:category:rename:${category.id}`)
    .text("📝 DESCRIPTION", `admin:category:description:${category.id}`)
    .row()
    .text("🎨 ICON", `admin:category:emoji:${category.id}`)
    .text("⬆️", `admin:category:reorder:${category.id}:-1`)
    .text("⬇️", `admin:category:reorder:${category.id}:1`)
    .row()
    .text("🗑 DELETE", `admin:category:delete:${category.id}`)
    .text("◀ CATEGORIES", "admin:categories");
}

export function productDetailKeyboard(product: Product & { category: Category; _count: { inventory: number } }): InlineKeyboard {
  return new InlineKeyboard()
    .text("✏️ NAME", `admin:product:edit:name:${product.id}`)
    .text("📝 DESCRIPTION", `admin:product:edit:description:${product.id}`)
    .row()
    .text("💳 PRICE", `admin:product:edit:price:${product.id}`)
    .text("🎨 ICON", `admin:product:edit:emoji:${product.id}`)
    .row()
    .text("🗂 CATEGORY", `admin:product:category:${product.id}`)
    .text(product.enabled ? "⏸ DISABLE" : "▶ ENABLE", `admin:product:toggle:${product.id}`)
    .row()
    .text("📥 ADD STOCK", `admin:stock:add:${product.id}`)
    .text("📋 VIEW STOCK", `admin:stock:list:${product.id}:0`)
    .row()
    .text("🗑 DELETE", `admin:product:delete:${product.id}`)
    .text("◀ PRODUCTS", "admin:products:0");
}

export function adminPanelKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("📦 Products", "admin:products:0")
    .text("🗂 Categories", "admin:categories")
    .row()
    .text("📋 Inventory", "admin:inventory")
    .text("👥 Users", "admin:users:0")
    .row()
    .text("🎁 Credits", "admin:credits")
    .text("🔑 Redeem codes", "admin:codes:0")
    .row()
    .text("📢 Broadcast", "admin:broadcast")
    .text("📊 Statistics", "admin:stats")
    .row()
    .text("📤 Export", "admin:export")
    .text("⚙️ Settings", "admin:settings")
    .row()
    .text("🧾 Purchases", "admin:purchases:0")
    .text("🔄 Restart", "admin:restart")
    .row()
    .text("⚠️ Reset", "admin:reset")
    .text("🏠 HOME", "nav:home");
}

export function adminBackKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("◀ ADMIN", "admin:panel").text("🏠 HOME", "nav:home");
}

export function categoryListAdminKeyboard(categories: Category[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const category of categories) {
    const enabled = category.enabled ? "🟢" : "⚪";
    keyboard.text(`${enabled} ${category.emoji} ${category.name}`.slice(0, 55), `admin:category:view:${category.id}`).row();
  }
  keyboard.text("➕ ADD CATEGORY", "admin:category:add").row();
  keyboard.text("◀ ADMIN", "admin:panel");
  return keyboard;
}

export function categoryProductsAdminKeyboard(
  products: Array<Product & { category: Category; _count: { inventory: number } }>,
  categoryId: string,
  page: number,
  totalPages: number,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const product of products) {
    keyboard.text(
      `${product.emoji} ${product.name} · ${product.price}c · ${product._count.inventory} stock`.slice(0, 58),
      `admin:product:view:${product.id}`,
    ).row();
  }
  if (page > 0) keyboard.text("◀", `admin:category:products:${categoryId}:${page - 1}`);
  keyboard.text(`${page + 1}/${totalPages}`, "noop");
  if (page + 1 < totalPages) keyboard.text("▶", `admin:category:products:${categoryId}:${page + 1}`);
  keyboard.row().text("➕ ADD PRODUCT", `admin:product:add:${categoryId}`);
  keyboard.row().text("◀ CATEGORY", `admin:category:view:${categoryId}`);
  return keyboard;
}

export function inventoryCategoriesKeyboard(categories: Category[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const category of categories) {
    keyboard.text(`${category.emoji} ${category.name}`, `admin:inventory:category:${category.id}`).row();
  }
  return keyboard.text("◀ ADMIN", "admin:panel");
}

export function inventoryProductsKeyboard(
  products: Array<Product & { category: Category; _count: { inventory: number } }>,
  categoryId: string,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const product of products) {
    keyboard.text(
      `${product.emoji} ${product.name} · ${product._count.inventory} available`.slice(0, 58),
      `admin:stock:product:${product.id}`,
    ).row();
  }
  return keyboard.text("◀ CATEGORY", `admin:inventory:category:${categoryId}`);
}

export function confirmPurchaseKeyboard(productId: string, nonce: string, expectedPrice: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("🛒 CONFIRM BUY", `buy:confirm:${productId}:${nonce}:${expectedPrice.toString(36)}`)
    .text("◀ BACK", `store:product:${productId}`);
}

export function confirmDangerKeyboard(confirmData: string, backData: string): InlineKeyboard {
  return new InlineKeyboard().text("⚠️ CONFIRM", confirmData).text("❌ CANCEL", backData);
}

export function userPaginationKeyboard(page: number, pages: number): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (page > 0) keyboard.text("◀", `admin:users:${page - 1}`);
  keyboard.text(`${page + 1}/${pages}`, "noop");
  if (page + 1 < pages) keyboard.text("▶", `admin:users:${page + 1}`);
  keyboard.row().text("◀ ADMIN", "admin:panel");
  return keyboard;
}

export function codeListKeyboard(codes: RedeemCode[], page: number, pages: number): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const code of codes) {
    const status = code.enabled ? "🟢" : "⚪";
    keyboard.text(`${status} ${code.code} · ${code.currentRedeems}/${code.maxRedeems}`, `admin:code:view:${code.id}`).row();
  }
  if (page > 0) keyboard.text("◀", `admin:codes:${page - 1}`);
  keyboard.text(`${page + 1}/${pages}`, "noop");
  if (page + 1 < pages) keyboard.text("▶", `admin:codes:${page + 1}`);
  keyboard.row().text("◀ ADMIN", "admin:panel");
  return keyboard;
}
