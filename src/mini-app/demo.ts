import type { PrismaClient } from "../generated/prisma/client.js";
import { changeCredits } from "../services/credits.service.js";
import { addInventoryItems } from "../services/store.service.js";
import { purchaseProduct } from "../services/purchases.service.js";
import { processReferralStart, buildReferralStartPayload } from "../services/referrals.service.js";
import { DEMO_TELEGRAM_ID } from "./server.js";

/** Seed only the isolated Mini App preview database, never an application's configured PostgreSQL store. */
export async function seedMiniDemo(db: PrismaClient) {
  const marker = await db.appSetting.findUnique({ where: { key: "mini_demo_seed_v1" } });
  const existing = await db.user.findUnique({ where: { telegramId: DEMO_TELEGRAM_ID } });
  if (marker && existing) return;
  const user = await db.user.upsert({
    where: { telegramId: DEMO_TELEGRAM_ID },
    create: { telegramId: DEMO_TELEGRAM_ID, firstName: "Alex", lastName: "River", username: "alex_iris", createdAt: new Date("2026-09-14T10:00:00Z") }, update: {},
  });
  const categoryNames = ["Streaming", "Gaming", "Productivity", "Creative"];
  const categoryEmoji = ["🎵", "🎮", "⚡", "🎨"];
  const categories = await Promise.all(categoryNames.map((name, index) => db.category.upsert({
    where: { name }, create: { name, emoji: categoryEmoji[index]!, displayOrder: index, description: `Curated ${name.toLowerCase()} essentials` }, update: {},
  })));
  const specs = [
    { name: "Spotify Gift Card", category: 0, price: 250, emoji: "🎵", description: "A soundtrack for every version of you.", plan: "Digital gift code · Music & streaming", imageUrl: "/product-art/spotify.svg" },
    { name: "Discord Nitro", category: 1, price: 180, emoji: "🎮", description: "Make your corner of the internet feel like you.", plan: "Digital gift code · Community & gaming" },
    { name: "Notion Creator Kit", category: 2, price: 120, emoji: "📝", description: "A little structure for your big ideas.", plan: "Creator workspace · 12 digital templates" },
    { name: "Canva Templates", category: 3, price: 160, emoji: "🎨", description: "Good-looking ideas, without the blank canvas.", plan: "Social essentials · 40 editable templates", imageUrl: "/product-art/canva.svg" },
    { name: "Steam Wallet Gift", category: 1, price: 225, emoji: "🕹️", description: "Your next adventure is just one click away.", plan: "Digital wallet gift code · Gaming" },
    { name: "Figma UI Library", category: 3, price: 320, emoji: "✦", description: "Beautiful building blocks for your next big thing.", plan: "Design essentials · 200 UI components" },
    { name: "Lightroom Presets", category: 3, price: 95, emoji: "📸", description: "Find your signature look. Keep the good light.", plan: "Everyday collection · 24 presets", imageUrl: "/product-art/lightroom.svg" },
    { name: "Crunchyroll Gift Card", category: 0, price: 210, emoji: "🍿", description: "Escape into a story that stays with you.", plan: "Digital gift code · Anime & entertainment" },
  ];
  const products = [];
  for (const [index, spec] of specs.entries()) {
    const product = await db.product.upsert({
      where: { categoryId_name: { categoryId: categories[spec.category]!.id, name: spec.name } },
      create: {
        categoryId: categories[spec.category]!.id, name: spec.name, price: spec.price, emoji: spec.emoji,
        description: spec.description, planDetails: spec.plan, featured: index < 4, warrantyHours: 168,
        imageUrl: spec.imageUrl ?? null,
        deliveryInstructions: "PREVIEW ONLY: this is synthetic demo stock. No real account, gift card, subscription or download is included. In your live store, the owner supplies legitimate, authorized digital goods and delivery instructions.",
      }, update: {},
    });
    await addInventoryItems(db, product.id, Array.from({ length: 12 }, (_, i) => `DEMO-${spec.name.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 10)}-${String(i + 1).padStart(4, "0")}`));
    products.push(product);
  }
  if (!await db.creditTransaction.findFirst({ where: { userId: user.id, batchId: "mini-demo-welcome" } })) {
    await changeCredits(db, { userId: user.id, amount: 1725, type: "GIFT", description: "Welcome to your Iris demo wallet", batchId: "mini-demo-welcome" });
  }
  for (const [index, product] of [products[0]!, products[3]!, products[6]!].entries()) {
    await purchaseProduct(db, user.id, product.id, `demo-seed-order-${index}`, product.price);
  }
  for (const [index, firstName] of ["Jamie", "Sam", "Taylor"].entries()) {
    await processReferralStart(db, { id: 50_010 + index, is_bot: false, first_name: firstName, username: `${firstName.toLowerCase()}_demo` }, buildReferralStartPayload(DEMO_TELEGRAM_ID));
  }
  for (const product of [products[2]!, products[5]!]) {
    await db.wishlistItem.upsert({ where: { userId_productId: { userId: user.id, productId: product.id } }, create: { userId: user.id, productId: product.id }, update: {} });
  }
  await db.redeemCode.upsert({
    where: { code: "IRIS-DEMO-GIFT-PACK" }, create: { code: "IRIS-DEMO-GIFT-PACK", creditAmount: 100, maxRedeems: 1000, createdBy: DEMO_TELEGRAM_ID }, update: {},
  });
  await db.appSetting.upsert({ where: { key: "mini_demo_seed_v1" }, create: { key: "mini_demo_seed_v1", value: "seeded" }, update: { value: "seeded" } });
}
