import { createHash, randomUUID } from "node:crypto";
import type { PrismaClient } from "../generated/prisma/client.js";
import type { WarrantyClaimStatus } from "../generated/prisma/enums.js";
import {
  InsufficientCreditsError,
  NotFoundError,
  OutOfStockError,
  PriceChangedError,
  ValidationError,
} from "../utils/errors.js";

export interface PurchaseResult {
  purchaseId: string;
  productName: string;
  productEmoji: string;
  paid: number;
  remainingCredits: number;
  payload: string;
  payloads?: string[];
  quantity?: number;
  repeated: boolean;
  planDetails?: string;
  deliveryInstructions?: string;
  warrantyHours?: number;
}

export async function purchaseProduct(
  prisma: PrismaClient,
  userId: string,
  productId: string,
  idempotencyKey: string,
  expectedPrice?: number,
  quantity = 1,
): Promise<PurchaseResult> {
  if (!idempotencyKey || idempotencyKey.length > 128) {
    throw new ValidationError("Purchase request expired. Open the product and try again.");
  }
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 10) {
    throw new ValidationError("Quantity must be between 1 and 10.");
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
        payloads: [existing.inventoryItem.payload],
        quantity: 1,
        repeated: true,
        planDetails: existing.product.planDetails,
        deliveryInstructions: existing.product.deliveryInstructions,
        warrantyHours: existing.product.warrantyHours,
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

    const totalCost = product.price * quantity;
    const dbTimeRows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    const now = dbTimeRows[0]?.now;
    if (!now) throw new Error("PostgreSQL did not return its current time.");

    const assignedItems: Array<{ id: string; payload: string }> = [];

    if (product.isUnlimited) {
      const templateRows = await tx.$queryRaw<Array<{ id: string; payload: string }>>`
        SELECT id, payload
        FROM inventory_items
        WHERE product_id = ${productId} AND status = 'AVAILABLE'
        ORDER BY created_at ASC, id ASC
        LIMIT 1
        FOR SHARE
      `;
      const template = templateRows[0];
      if (!template) throw new OutOfStockError();
      if (user.credits < totalCost) throw new InsufficientCreditsError();

      for (let i = 0; i < quantity; i++) {
        const cloneId = randomUUID();
        const cloneHash = createHash("sha256").update(`${template.payload}#unlimited:${cloneId}`).digest("hex");
        await tx.inventoryItem.create({
          data: {
            id: cloneId,
            productId,
            payload: template.payload,
            payloadHash: cloneHash,
            status: "SOLD",
            purchaserId: userId,
            purchasedAt: now,
          },
        });
        assignedItems.push({ id: cloneId, payload: template.payload });
      }
    } else {
      const stockRows = await tx.$queryRaw<Array<{ id: string; payload: string }>>`
        SELECT id, payload
        FROM inventory_items
        WHERE product_id = ${productId} AND status = 'AVAILABLE'
        ORDER BY created_at ASC, id ASC
        LIMIT ${quantity}
        FOR UPDATE SKIP LOCKED
      `;
      if (stockRows.length < quantity) throw new OutOfStockError();
      if (user.credits < totalCost) throw new InsufficientCreditsError();

      for (const stock of stockRows) {
        const reserved = await tx.inventoryItem.updateMany({
          where: { id: stock.id, status: "AVAILABLE" },
          data: { status: "SOLD", purchaserId: userId, purchasedAt: now },
        });
        if (!reserved.count) throw new OutOfStockError();
        assignedItems.push(stock);
      }
    }

    const debited = await tx.user.updateMany({
      where: { id: userId, credits: { gte: totalCost } },
      data: { credits: { decrement: totalCost } },
    });
    if (!debited.count) throw new InsufficientCreditsError();
    const updatedUser = await tx.user.findUniqueOrThrow({ where: { id: userId } });

    let firstPurchaseId = "";
    for (let i = 0; i < assignedItems.length; i++) {
      const item = assignedItems[i]!;
      const key = i === 0 ? idempotencyKey : `${idempotencyKey}:${i}`.slice(0, 128);
      const purchase = await tx.purchase.create({
        data: {
          id: randomUUID(),
          buyerId: userId,
          productId,
          inventoryItemId: item.id,
          amountPaid: product.price,
          idempotencyKey: key,
          createdAt: now,
        },
      });
      if (i === 0) firstPurchaseId = purchase.id;
    }

    await tx.creditTransaction.create({
      data: {
        id: randomUUID(),
        userId,
        amount: -totalCost,
        type: "PURCHASE",
        description: (quantity > 1 ? `Purchased ${quantity}x ${product.name}` : `Purchased ${product.name}`).slice(0, 500),
        relatedEntityId: firstPurchaseId,
        balanceAfter: updatedUser.credits,
        createdAt: now,
      },
    });

    const payloads = assignedItems.map((item) => item.payload);
    return {
      purchaseId: firstPurchaseId,
      productName: product.name,
      productEmoji: product.emoji,
      paid: totalCost,
      remainingCredits: updatedUser.credits,
      payload: payloads.join("\n"),
      payloads,
      quantity,
      repeated: false,
      planDetails: product.planDetails,
      deliveryInstructions: product.deliveryInstructions,
      warrantyHours: product.warrantyHours,
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
        planDetails: existing.product.planDetails,
        deliveryInstructions: existing.product.deliveryInstructions,
        warrantyHours: existing.product.warrantyHours,
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
      product: { select: { name: true, emoji: true, warrantyHours: true } },
      inventoryItem: { select: { id: true } },
      warrantyClaim: { select: { id: true, status: true } },
    },
  });
}

export async function getUserPurchaseDetail(
  prisma: PrismaClient,
  userId: string,
  purchaseId: string,
) {
  const purchase = await prisma.purchase.findFirst({
    where: { id: purchaseId, buyerId: userId },
    include: {
      product: {
        include: { category: { select: { name: true } } },
      },
      inventoryItem: true,
      warrantyClaim: true,
    },
  });
  if (!purchase) throw new NotFoundError("That order was not found in your account.");
  return purchase;
}

export async function submitWarrantyClaim(
  prisma: PrismaClient,
  userId: string,
  purchaseId: string,
  reason: string,
) {
  const trimmedReason = reason.trim();
  if (trimmedReason.length < 3 || trimmedReason.length > 500) {
    throw new ValidationError("Please describe the issue in 3–500 characters.");
  }

  return prisma.$transaction(async (tx) => {
    const purchase = await tx.purchase.findFirst({
      where: { id: purchaseId, buyerId: userId },
      include: {
        product: true,
        warrantyClaim: true,
        buyer: { select: { telegramId: true, username: true } },
      },
    });
    if (!purchase) throw new NotFoundError("That order does not belong to your account.");
    if (purchase.warrantyClaim) {
      throw new ValidationError(`A warranty claim is already ${purchase.warrantyClaim.status.toLowerCase()} for this order.`);
    }
    if (purchase.product.warrantyHours <= 0) {
      throw new ValidationError("This product does not include replacement warranty coverage.");
    }
    const expiresAt = purchase.createdAt.getTime() + purchase.product.warrantyHours * 3_600_000;
    if (Date.now() > expiresAt) {
      throw new ValidationError("The warranty period for this order has expired.");
    }
    return tx.warrantyClaim.create({
      data: {
        id: randomUUID(),
        purchaseId: purchase.id,
        buyerId: userId,
        productId: purchase.productId,
        reason: trimmedReason,
        status: "PENDING",
      },
      include: {
        product: { select: { id: true, name: true, emoji: true } },
        buyer: { select: { id: true, telegramId: true, username: true } },
        purchase: { select: { id: true, amountPaid: true, createdAt: true } },
      },
    });
  });
}

export async function listWarrantyClaims(
  prisma: PrismaClient,
  page = 0,
  pageSize = 8,
  status?: WarrantyClaimStatus,
) {
  const where = status ? { status } : {};
  const [claims, total, pendingCount] = await Promise.all([
    prisma.warrantyClaim.findMany({
      where,
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      skip: Math.max(0, page) * pageSize,
      take: pageSize,
      include: {
        product: { select: { name: true, emoji: true } },
        buyer: { select: { telegramId: true, username: true, firstName: true } },
        purchase: { select: { amountPaid: true } },
      },
    }),
    prisma.warrantyClaim.count({ where }),
    prisma.warrantyClaim.count({ where: { status: "PENDING" } }),
  ]);
  return { claims, total, pendingCount, pages: Math.max(1, Math.ceil(total / pageSize)) };
}

export async function getWarrantyClaimDetail(prisma: PrismaClient, claimId: string) {
  const claim = await prisma.warrantyClaim.findUnique({
    where: { id: claimId },
    include: {
      product: { select: { id: true, name: true, emoji: true, planDetails: true, deliveryInstructions: true } },
      buyer: { select: { id: true, telegramId: true, username: true, firstName: true } },
      purchase: { include: { inventoryItem: true } },
    },
  });
  if (!claim) throw new NotFoundError("That warranty claim no longer exists.");
  return claim;
}

export async function resolveWarrantyClaimReplace(prisma: PrismaClient, claimId: string) {
  return prisma.$transaction(async (tx) => {
    const claim = await tx.warrantyClaim.findUnique({
      where: { id: claimId },
      include: {
        product: true,
        buyer: true,
        purchase: true,
      },
    });
    if (!claim) throw new NotFoundError("That warranty claim no longer exists.");
    if (claim.status !== "PENDING") {
      throw new ValidationError(`This claim was already ${claim.status.toLowerCase()}.`);
    }

    const stockRows = await tx.$queryRaw<Array<{ id: string; payload: string }>>`
      SELECT id, payload
      FROM inventory_items
      WHERE product_id = ${claim.productId} AND status = 'AVAILABLE'
      ORDER BY created_at ASC, id ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `;
    const replacement = stockRows[0];
    if (!replacement) {
      throw new OutOfStockError("No available stock to replace this order. Add authorized stock before approving the claim.");
    }

    const now = new Date();
    const reserved = await tx.inventoryItem.updateMany({
      where: { id: replacement.id, status: "AVAILABLE" },
      data: { status: "SOLD", purchaserId: claim.buyerId, purchasedAt: now },
    });
    if (!reserved.count) throw new OutOfStockError();

    const oldItemId = claim.purchase.inventoryItemId;
    await tx.purchase.update({
      where: { id: claim.purchaseId },
      data: { inventoryItemId: replacement.id },
    });
    await tx.inventoryItem.updateMany({
      where: { id: oldItemId },
      data: { status: "REMOVED" },
    });

    const updatedClaim = await tx.warrantyClaim.update({
      where: { id: claim.id },
      data: {
        status: "REPLACED",
        replacementItemId: replacement.id,
        resolutionNote: "Replaced with fresh authorized stock",
        resolvedAt: now,
      },
    });

    return {
      claim: updatedClaim,
      buyerTelegramId: claim.buyer.telegramId,
      product: claim.product,
      purchaseId: claim.purchaseId,
      replacementPayload: replacement.payload,
    };
  });
}

export async function resolveWarrantyClaimReject(
  prisma: PrismaClient,
  claimId: string,
  note = "Claim did not meet warranty terms.",
) {
  const claim = await prisma.warrantyClaim.findUnique({
    where: { id: claimId },
    include: { product: true, buyer: true },
  });
  if (!claim) throw new NotFoundError("That warranty claim no longer exists.");
  if (claim.status !== "PENDING") {
    throw new ValidationError(`This claim was already ${claim.status.toLowerCase()}.`);
  }
  const updated = await prisma.warrantyClaim.update({
    where: { id: claim.id },
    data: {
      status: "REJECTED",
      resolutionNote: note.slice(0, 500),
      resolvedAt: new Date(),
    },
  });
  return {
    claim: updated,
    buyerTelegramId: claim.buyer.telegramId,
    product: claim.product,
    purchaseId: claim.purchaseId,
  };
}
