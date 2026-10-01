import { InlineKeyboard } from "grammy";
import type { Category, Product, RedeemCode } from "../generated/prisma/client.js";
import { PRODUCT_DELIVERY_PRESETS } from "../utils/credential-parser.js";
import { smallCaps } from "../utils/format.js";

export function mainKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text(smallCaps("🛍 Browse store"), "nav:store")
    .text(smallCaps("🎁 Daily bonus"), "nav:bonus")
    .row()
    .text(smallCaps("📦 My orders"), "nav:orders")
    .text(smallCaps("👤 Profile"), "nav:profile")
    .row()
    .text(smallCaps("💳 Wallet"), "nav:wallet")
    .text(smallCaps("ℹ️ Help"), "nav:help")
    .row()
    .url(smallCaps("👑 Contact support"), "https://t.me/YoriNetwork");
}

export function profileKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text(smallCaps("🛍 Store"), "nav:store")
    .text(smallCaps("💳 Wallet"), "nav:wallet")
    .row()
    .text(smallCaps("🎁 Bonus"), "nav:bonus")
    .text(smallCaps("📦 Orders"), "nav:orders")
    .row()
    .text(smallCaps("◀ Main menu"), "nav:home");
}

export function backHomeKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text(smallCaps("◀ Main menu"), "nav:home");
}

export function categoriesKeyboard(
  categories: Array<Category & { _count: { products: number } }>,
  featuredCount = 0,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (featuredCount > 0) {
    keyboard.text(smallCaps(`🔥 Featured items · ${featuredCount}`), "store:featured:0").row();
  }
  for (const category of categories) {
    keyboard.text(
      smallCaps(`${category.emoji} ${category.name} · ${category._count.products}`),
      `store:category:${category.id}:0`,
    ).row();
  }
  keyboard.text(smallCaps("🔍 Search"), "store:search:start").text(smallCaps("◀ Home"), "nav:home");
  return keyboard;
}

export function storeCategoryProductsKeyboard(
  products: Array<Product & { category: Category; _count: { inventory: number } }>,
  categoryId: string,
  page: number,
  totalPages: number,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const product of products) {
    const status = product._count.inventory > 0 ? "" : " · Out of stock";
    const badge = product.featured ? "🔥 " : "";
    keyboard.text(
      smallCaps(`${badge}${product.emoji} ${product.name} · ${product.price} credits${status}`).slice(0, 58),
      `store:product:${product.id}`,
    ).row();
  }
  if (page > 0) keyboard.text(smallCaps("◀"), `store:category:${categoryId}:${page - 1}`);
  keyboard.text(smallCaps(`${page + 1}/${totalPages}`), "noop");
  if (page + 1 < totalPages) keyboard.text(smallCaps("▶"), `store:category:${categoryId}:${page + 1}`);
  keyboard.row().text(smallCaps("◀ CATEGORIES"), "nav:store").text(smallCaps("🏠 HOME"), "nav:home");
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
    const status = product.enabled && product._count.inventory > 0 ? "" : " · Unavailable";
    const badge = product.featured ? "🔥 " : "";
    const prefix = namespace === "store" ? "store:product:" : "admin:product:view:";
    keyboard.text(
      smallCaps(`${badge}${product.emoji} ${product.name} · ${product.price}c${status}`).slice(0, 58),
      `${prefix}${product.id}`,
    ).row();
  }
  const previous = page > 0;
  const next = page + 1 < totalPages;
  if (previous || next) {
    if (previous) keyboard.text(smallCaps("◀"), `${namespace}:products:${page - 1}`);
    keyboard.text(smallCaps(`${page + 1}/${totalPages}`), "noop");
    if (next) keyboard.text(smallCaps("▶"), `${namespace}:products:${page + 1}`);
    keyboard.row();
  }
  keyboard.text(smallCaps("◀ BACK"), backData).text(smallCaps("🏠 HOME"), "nav:home");
  return keyboard;
}

export function categoryDetailKeyboard(category: Category): InlineKeyboard {
  return new InlineKeyboard()
    .text(smallCaps("📦 PRODUCTS"), `admin:category:products:${category.id}:0`)
    .text(smallCaps(category.enabled ? "⏸ DISABLE" : "▶ ENABLE"), `admin:category:toggle:${category.id}`)
    .row()
    .text(smallCaps("✏️ RENAME"), `admin:category:rename:${category.id}`)
    .text(smallCaps("📝 DESCRIPTION"), `admin:category:description:${category.id}`)
    .row()
    .text(smallCaps("🎨 ICON"), `admin:category:emoji:${category.id}`)
    .text(smallCaps("⬆️"), `admin:category:reorder:${category.id}:-1`)
    .text(smallCaps("⬇️"), `admin:category:reorder:${category.id}:1`)
    .row()
    .text(smallCaps("🗑 DELETE"), `admin:category:delete:${category.id}`)
    .text(smallCaps("◀ CATEGORIES"), "admin:categories");
}

export function productDetailKeyboard(product: Product & { category: Category; _count: { inventory: number } }): InlineKeyboard {
  return new InlineKeyboard()
    .text(smallCaps("✏️ NAME"), `admin:product:edit:name:${product.id}`)
    .text(smallCaps("📝 DESCRIPTION"), `admin:product:edit:description:${product.id}`)
    .row()
    .text(smallCaps("💎 PLAN SPECS"), `admin:product:edit:plan:${product.id}`)
    .text(smallCaps("📜 LOGIN GUIDE"), `admin:product:edit:instructions:${product.id}`)
    .row()
    .text(smallCaps("⚡ PRESETS"), `admin:product:presets:${product.id}`)
    .text(smallCaps(`🛡 WARRANTY (${product.warrantyHours}h)`), `admin:product:edit:warranty:${product.id}`)
    .row()
    .text(smallCaps("💳 PRICE"), `admin:product:edit:price:${product.id}`)
    .text(smallCaps("🎨 ICON"), `admin:product:edit:emoji:${product.id}`)
    .row()
    .text(smallCaps("🖼 BANNER"), `admin:product:edit:media:${product.id}`)
    .text(smallCaps(product.featured ? "🔥 UNFEATURE" : "🔥 FEATURE"), `admin:product:featured:${product.id}`)
    .row()
    .text(smallCaps(product.isUnlimited ? "♾ UNLIMITED: ON" : "♾ UNLIMITED: OFF"), `admin:product:unlimited:${product.id}`)
    .text(smallCaps("🗂 CATEGORY"), `admin:product:category:${product.id}`)
    .row()
    .text(smallCaps(product.enabled ? "⏸ DISABLE" : "▶ ENABLE"), `admin:product:toggle:${product.id}`)
    .text(smallCaps("🧬 CLONE"), `admin:product:clone:${product.id}`)
    .row()
    .text(smallCaps("📥 ADD STOCK"), `admin:stock:add:${product.id}`)
    .text(smallCaps("📋 VIEW STOCK"), `admin:stock:list:${product.id}:0`)
    .row()
    .text(smallCaps("🗑 DELETE"), `admin:product:delete:${product.id}`)
    .text(smallCaps("◀ PRODUCTS"), "admin:products:0");
}

export function productPresetsKeyboard(productId: string): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const preset of Object.values(PRODUCT_DELIVERY_PRESETS)) {
    keyboard.text(smallCaps(preset.buttonLabel), `admin:product:preset:${productId}:${preset.id}`).row();
  }
  keyboard
    .text(smallCaps("💎 EDIT PLAN SPECS"), `admin:product:edit:plan:${productId}`)
    .text(smallCaps("📜 EDIT GUIDE"), `admin:product:edit:instructions:${productId}`)
    .row()
    .text(smallCaps("◀ PRODUCT"), `admin:product:view:${productId}`);
  return keyboard;
}

export function adminPanelKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text(smallCaps("📦 Products"), "admin:products:0")
    .text(smallCaps("🗂 Categories"), "admin:categories")
    .row()
    .text(smallCaps("📋 Inventory"), "admin:inventory")
    .text(smallCaps("🔑 Codes"), "admin:codes:0")
    .row()
    .text(smallCaps("👥 Users"), "admin:users:0")
    .text(smallCaps("🎁 Credits"), "admin:credits")
    .row()
    .text(smallCaps("🧾 Purchases"), "admin:purchases:0")
    .text(smallCaps("🛡 Warranty"), "admin:warranty:0")
    .row()
    .text(smallCaps("📢 Broadcast"), "admin:broadcast")
    .text(smallCaps("📊 Statistics"), "admin:stats")
    .row()
    .text(smallCaps("📤 Export"), "admin:export")
    .text(smallCaps("⚙️ Settings"), "admin:settings")
    .row()
    .text(smallCaps("🔄 Restart"), "admin:restart")
    .text(smallCaps("⚠️ Reset store"), "admin:reset")
    .row()
    .text(smallCaps("🏠 Storefront"), "nav:home");
}

export function adminBackKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text(smallCaps("◀ Control center"), "admin:panel").text(smallCaps("🏠 Storefront"), "nav:home");
}

export function categoryListAdminKeyboard(categories: Category[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const category of categories) {
    const enabled = category.enabled ? "🟢" : "⚪";
    keyboard.text(smallCaps(`${enabled} ${category.emoji} ${category.name}`).slice(0, 55), `admin:category:view:${category.id}`).row();
  }
  keyboard.text(smallCaps("➕ ADD CATEGORY"), "admin:category:add").row();
  keyboard.text(smallCaps("◀ ADMIN"), "admin:panel");
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
    const badge = product.featured ? "🔥 " : "";
    keyboard.text(
      smallCaps(`${badge}${product.emoji} ${product.name} · ${product.price}c · ${product._count.inventory} stock`).slice(0, 58),
      `admin:product:view:${product.id}`,
    ).row();
  }
  if (page > 0) keyboard.text(smallCaps("◀"), `admin:category:products:${categoryId}:${page - 1}`);
  keyboard.text(smallCaps(`${page + 1}/${totalPages}`), "noop");
  if (page + 1 < totalPages) keyboard.text(smallCaps("▶"), `admin:category:products:${categoryId}:${page + 1}`);
  keyboard.row().text(smallCaps("➕ ADD PRODUCT"), `admin:product:add:${categoryId}`);
  keyboard.row().text(smallCaps("◀ CATEGORY"), `admin:category:view:${categoryId}`);
  return keyboard;
}

export function inventoryCategoriesKeyboard(categories: Category[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const category of categories) {
    keyboard.text(smallCaps(`${category.emoji} ${category.name}`), `admin:inventory:category:${category.id}`).row();
  }
  return keyboard.text(smallCaps("◀ ADMIN"), "admin:panel");
}

export function inventoryProductsKeyboard(
  products: Array<Product & { category: Category; _count: { inventory: number } }>,
  categoryId: string,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const product of products) {
    keyboard.text(
      smallCaps(`${product.emoji} ${product.name} · ${product._count.inventory} available`).slice(0, 58),
      `admin:stock:product:${product.id}`,
    ).row();
  }
  return keyboard.text(smallCaps("◀ CATEGORY"), `admin:inventory:category:${categoryId}`);
}

export function confirmPurchaseKeyboard(
  productId: string,
  nonce: string,
  expectedPrice: number,
  quantity = 1,
  maxAvailable = 1,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (maxAvailable >= 2) {
    for (const qty of [1, 2, 3, 5]) {
      if (qty <= maxAvailable) {
        const label = smallCaps(qty === quantity ? `✅ ${qty}x` : `${qty}x`);
        keyboard.text(label, `buy:qty:${productId}:${qty}`);
      }
    }
    keyboard.row();
  }
  return keyboard
    .text(
      smallCaps(quantity > 1 ? `🛒 CONFIRM BUY (${quantity}x)` : "🛒 CONFIRM BUY"),
      `buy:confirm:${productId}:${nonce}:${expectedPrice.toString(36)}`,
    )
    .text(smallCaps("◀ BACK"), `store:product:${productId}`);
}

export function confirmDangerKeyboard(confirmData: string, backData: string): InlineKeyboard {
  return new InlineKeyboard().text(smallCaps("⚠️ CONFIRM"), confirmData).text(smallCaps("❌ CANCEL"), backData);
}

export function userPaginationKeyboard(page: number, pages: number): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (page > 0) keyboard.text(smallCaps("◀"), `admin:users:${page - 1}`);
  keyboard.text(smallCaps(`${page + 1}/${pages}`), "noop");
  if (page + 1 < pages) keyboard.text(smallCaps("▶"), `admin:users:${page + 1}`);
  keyboard.row().text(smallCaps("◀ ADMIN"), "admin:panel");
  return keyboard;
}

export function codeListKeyboard(codes: RedeemCode[], page: number, pages: number): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const code of codes) {
    const status = code.enabled ? "🟢" : "⚪";
    keyboard.text(`${status} ${code.code} · ${code.currentRedeems}/${code.maxRedeems}`, `admin:code:view:${code.id}`).row();
  }
  if (page > 0) keyboard.text(smallCaps("◀"), `admin:codes:${page - 1}`);
  keyboard.text(smallCaps(`${page + 1}/${pages}`), "noop");
  if (page + 1 < pages) keyboard.text(smallCaps("▶"), `admin:codes:${page + 1}`);
  keyboard.row().text(smallCaps("◀ ADMIN"), "admin:panel");
  return keyboard;
}
