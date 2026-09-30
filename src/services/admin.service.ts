import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "../generated/prisma/client.js";
import { ValidationError } from "../utils/errors.js";

export interface ResetPreview {
  users: number;
  categories: number;
  products: number;
  inventory: number;
  purchases: number;
  redeemCodes: number;
  redemptions: number;
  creditTransactions: number;
}

export async function getResetPreview(prisma: PrismaClient | Prisma.TransactionClient): Promise<ResetPreview> {
  const [users, categories, products, inventory, purchases, redeemCodes, redemptions, creditTransactions] =
    await Promise.all([
      prisma.user.count(), prisma.category.count(), prisma.product.count(), prisma.inventoryItem.count(),
      prisma.purchase.count(), prisma.redeemCode.count(), prisma.codeRedemption.count(),
      prisma.creditTransaction.count(),
    ]);
  return { users, categories, products, inventory, purchases, redeemCodes, redemptions, creditTransactions };
}

export async function createResetChallenge(
  prisma: PrismaClient,
  ownerTelegramId: bigint,
): Promise<{ id: string; token: string; expiresAt: Date }> {
  const token = randomBytes(8).toString("hex");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const timeRows = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
  const now = timeRows[0]?.now;
  if (!now) throw new Error("PostgreSQL did not return its current time.");
  const expiresAt = new Date(now.getTime() + 2 * 60 * 1_000);
  const record = await prisma.resetChallenge.create({
    data: { id: randomBytes(5).toString("hex"), tokenHash, ownerTelegramId, stage: 1, expiresAt, createdAt: now },
  });
  return { id: record.id, token, expiresAt };
}

export function resetTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function advanceResetChallenge(
  prisma: PrismaClient,
  challengeId: string,
  token: string,
  ownerTelegramId: bigint,
) {
  const timeRows = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
  const now = timeRows[0]?.now;
  if (!now) throw new Error("PostgreSQL did not return its current time.");
  const changed = await prisma.resetChallenge.updateMany({
    where: {
      id: challengeId,
      ownerTelegramId,
      tokenHash: resetTokenHash(token),
      stage: 1,
      usedAt: null,
      expiresAt: { gt: now },
    },
    data: { stage: 2 },
  });
  if (!changed.count) throw new ValidationError("This reset confirmation has expired or was already used. Start /reset again.");
}

export async function cancelResetChallenge(
  prisma: PrismaClient,
  challengeId: string,
  ownerTelegramId: bigint,
): Promise<void> {
  await prisma.resetChallenge.updateMany({
    where: { id: challengeId, ownerTelegramId, usedAt: null },
    data: { usedAt: new Date() },
  });
}

export async function performConfirmedReset(
  prisma: PrismaClient,
  challengeId: string,
  token: string,
  ownerTelegramId: bigint,
): Promise<ResetPreview> {
  const tokenHash = resetTokenHash(token);
  return prisma.$transaction(async (tx) => {
    const timeRows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    const now = timeRows[0]?.now;
    if (!now) throw new Error("PostgreSQL did not return its current time.");

    const challenge = await tx.resetChallenge.updateMany({
      where: {
        id: challengeId,
        ownerTelegramId,
        tokenHash,
        stage: 2,
        usedAt: null,
        expiresAt: { gt: now },
      },
      data: { usedAt: now },
    });
    if (!challenge.count) throw new ValidationError("Reset confirmation invalid or expired. Nothing was deleted.");

    const preview = await getResetPreview(tx);
    await tx.warrantyClaim.deleteMany();
    await tx.stockSubscription.deleteMany();
    await tx.purchase.deleteMany();
    await tx.codeRedemption.deleteMany();
    await tx.inventoryItem.deleteMany();
    await tx.creditTransaction.deleteMany();
    await tx.redeemCode.deleteMany();
    await tx.product.deleteMany();
    await tx.category.deleteMany();
    await tx.user.deleteMany();
    await tx.adminAudit.create({
      data: {
        id: randomUUID(),
        ownerTelegramId,
        action: "RESET_COMPLETED",
        details: {
          users: preview.users,
          categories: preview.categories,
          products: preview.products,
          inventory: preview.inventory,
          purchases: preview.purchases,
          redeemCodes: preview.redeemCodes,
          redemptions: preview.redemptions,
          creditTransactions: preview.creditTransactions,
        },
        createdAt: now,
      },
    });
    return preview;
  }, { isolationLevel: "ReadCommitted", maxWait: 5_000, timeout: 30_000 });
}

export async function cleanupExpiredResetChallenges(prisma: PrismaClient): Promise<void> {
  const timeRows = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
  const now = timeRows[0]?.now;
  if (!now) return;
  await prisma.resetChallenge.deleteMany({ where: { expiresAt: { lt: now } } });
}
