import { randomUUID } from "node:crypto";
import type { PrismaClient } from "../generated/prisma/client.js";
import { InsufficientCreditsError, NotFoundError, OutOfStockError, PriceChangedError, ValidationError } from "../utils/errors.js";

export interface PurchaseResult {
  purchaseId: string;
  productName: string;
  productEmoji: string;
  paid: number;
  remainingCredits: number;
  payload: string;
  repeated: boolean;
}

export async function purchaseProduct(
  prisma: PrismaClient,
  userId: string,
  productId: string,
  idempotencyKey: string,
  expectedPrice?: number,
): Promise<PurchaseResult> {
  if (!idempotencyKey || idempotencyKey.length > 128) {
    throw new ValidationError("Purchase request expired. Open the product and try again.");
  }
  if (expectedPrice !== undefined &&
    (!Number.isSafeInteger(expectedPrice) || expectedPrice < 0 || expectedPrice > 1_000_000_000)) {
    throw new ValidationError("That purchase confirmation is invalid. Open the product again.");
  }

  const execute = () => prisma.$transaction(async (tx) => {
    const existing = await tx.purchase.findUnique({
      where: { idempotencyKey },
      include: { inventoryItem: true, product: true, buyer: { select: { id: true, credits: true } } },
    });
    if (existing) {
      if (existing.buyerId !== userId) throw new ValidationError("This purchase request is not yours.");
      return {
        purchaseId: existing.id,
        productName: existing.product.name,
        productEmoji: existing.product.emoji,
        paid: existing.amountPaid,
        remainingCredits: existing.buyer.credits,
        payload: existing.inventoryItem.payload,
        repeated: true,
      };
    }

    if (expectedPrice !== undefined) {
      const lockedProduct = await tx.$queryRaw<Array<{ price: number }>>`
        SELECT price
        FROM products
        WHERE id = ${productId}
        FOR SHARE
      `;
      if (!lockedProduct[0]) throw new NotFoundError("This product is no longer available.");
      if (lockedProduct[0].price !== expectedPrice) throw new PriceChangedError();
    }

    const product = await tx.product.findFirst({
      where: {
        id: productId,
        enabled: true,
        deletedAt: null,
        category: { enabled: true, deletedAt: null },
      },
      include: { category: true },
    });
    if (!product) throw new NotFoundError("This product is no longer available.");
    const user = await tx.user.findUnique({ where: { id: userId }, select: { id: true, credits: true } });
    if (!user) throw new NotFoundError("Send /start first so Iris can create your profile.");

    const stockRows = await tx.$queryRaw<Array<{ id: string; payload: string }>>`
      SELECT id, payload
      FROM inventory_items
      WHERE product_id = ${productId} AND status = 'AVAILABLE'
      ORDER BY created_at ASC, id ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `;
    const stock = stockRows[0];
    if (!stock) throw new OutOfStockError();
    if (user.credits < product.price) throw new InsufficientCreditsError();

    const dbTimeRows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    const now = dbTimeRows[0]?.now;
    if (!now) throw new Error("PostgreSQL did not return its current time.");
    const reserved = await tx.inventoryItem.updateMany({
      where: { id: stock.id, status: "AVAILABLE" },
      data: { status: "SOLD", purchaserId: userId, purchasedAt: now },
    });
    if (!reserved.count) throw new OutOfStockError();

    const debited = await tx.user.updateMany({
      where: { id: userId, credits: { gte: product.price } },
      data: { credits: { decrement: product.price } },
    });
    if (!debited.count) throw new InsufficientCreditsError();
    const updatedUser = await tx.user.findUniqueOrThrow({ where: { id: userId } });
    const purchase = await tx.purchase.create({
      data: {
        id: randomUUID(),
        buyerId: userId,
        productId,
        inventoryItemId: stock.id,
        amountPaid: product.price,
        idempotencyKey,
        createdAt: now,
      },
    });
    await tx.creditTransaction.create({
      data: {
        id: randomUUID(),
        userId,
        amount: -product.price,
        type: "PURCHASE",
        description: `Purchased ${product.name}`.slice(0, 500),
        relatedEntityId: purchase.id,
        balanceAfter: updatedUser.credits,
        createdAt: now,
      },
    });
    return {
      purchaseId: purchase.id,
      productName: product.name,
      productEmoji: product.emoji,
      paid: product.price,
      remainingCredits: updatedUser.credits,
      payload: stock.payload,
      repeated: false,
    };
  }, { isolationLevel: "ReadCommitted", maxWait: 5_000, timeout: 15_000 });

  try {
    return await execute();
  } catch (error) {
    // If Telegram retries a callback after the first transaction committed, return the same delivery.
    const existing = await prisma.purchase.findUnique({
      where: { idempotencyKey },
      include: { inventoryItem: true, product: true, buyer: { select: { id: true, credits: true } } },
    });
    if (existing && existing.buyerId === userId) {
      return {
        purchaseId: existing.id,
        productName: existing.product.name,
        productEmoji: existing.product.emoji,
        paid: existing.amountPaid,
        remainingCredits: existing.buyer.credits,
        payload: existing.inventoryItem.payload,
        repeated: true,
      };
    }
    if (existing) throw new ValidationError("This purchase request is not yours.");
    throw error;
  }
}

export async function listUserPurchases(prisma: PrismaClient, userId: string, skip = 0, take = 10) {
  return prisma.purchase.findMany({
    where: { buyerId: userId },
    orderBy: { createdAt: "desc" },
    skip,
    take,
    include: {
      product: { select: { name: true, emoji: true } },
      inventoryItem: { select: { id: true } },
    },
  });
}
