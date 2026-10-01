import type { PrismaClient } from "../generated/prisma/client.js";

export async function buildStoreExport(prisma: PrismaClient) {
  const [users, categories, products, inventory, codes, redemptions, purchases, creditTransactions, settings, auditLog, wishlist] =
    await Promise.all([
      prisma.user.findMany({ orderBy: { createdAt: "asc" } }),
      prisma.category.findMany({ orderBy: [{ displayOrder: "asc" }, { name: "asc" }] }),
      prisma.product.findMany({
        include: { category: { select: { id: true, name: true } } },
        orderBy: { createdAt: "asc" },
      }),
      prisma.inventoryItem.findMany({
        include: { product: { select: { id: true, name: true, categoryId: true } } },
        orderBy: { createdAt: "asc" },
      }),
      prisma.redeemCode.findMany({ orderBy: { createdAt: "asc" } }),
      prisma.codeRedemption.findMany({ orderBy: { redeemedAt: "asc" } }),
      prisma.purchase.findMany({
        include: {
          product: { select: { name: true, categoryId: true } },
          inventoryItem: { select: { id: true } },
          buyer: { select: { telegramId: true } },
        },
        orderBy: { createdAt: "asc" },
      }),
      prisma.creditTransaction.findMany({ orderBy: { createdAt: "asc" } }),
      prisma.appSetting.findMany({ orderBy: { key: "asc" } }),
      prisma.adminAudit.findMany({ orderBy: { createdAt: "asc" } }),
      prisma.wishlistItem.findMany({ orderBy: { createdAt: "asc" } }),
    ]);

  return {
    exportedAt: new Date().toISOString(),
    format: "iris-store-export-v2",
    users: users.map((user) => ({ ...user, telegramId: user.telegramId.toString() })),
    categories,
    products,
    inventory: inventory.map((item) => ({
      id: item.id,
      productId: item.productId,
      productName: item.product.name,
      categoryId: item.product.categoryId,
      payload: item.payload,
      status: item.status,
      createdAt: item.createdAt,
      purchasedAt: item.purchasedAt,
      purchaserId: item.purchaserId,
    })),
    redeemCodes: codes.map((code) => ({ ...code, createdBy: code.createdBy.toString() })),
    codeRedemptions: redemptions,
    purchases: purchases.map((purchase) => ({
      id: purchase.id,
      buyerTelegramId: purchase.buyer.telegramId.toString(),
      productId: purchase.productId,
      productName: purchase.product.name,
      inventoryItemId: purchase.inventoryItemId,
      idempotencyKey: purchase.idempotencyKey,
      batchId: purchase.batchId,
      batchIndex: purchase.batchIndex,
      amountPaid: purchase.amountPaid,
      createdAt: purchase.createdAt,
    })),
    creditTransactions,
    settings,
    wishlist,
    adminAudit: auditLog.map((entry) => ({ ...entry, ownerTelegramId: entry.ownerTelegramId.toString() })),
  };
}
