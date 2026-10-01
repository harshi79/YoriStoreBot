import { randomUUID } from "node:crypto";
import type { PrismaClient } from "../generated/prisma/client.js";
import type { CreditTransactionType } from "../generated/prisma/enums.js";
import { InsufficientCreditsError, NotFoundError, ValidationError } from "../utils/errors.js";

export const MAX_CREDITS = 2_000_000_000;

export async function listUserCreditTransactions(
  prisma: PrismaClient,
  userId: string,
  page = 0,
  pageSize = 8,
) {
  const safePage = Number.isSafeInteger(page) ? Math.max(0, page) : 0;
  const safePageSize = Number.isSafeInteger(pageSize)
    ? Math.max(1, Math.min(25, pageSize))
    : 8;
  const where = { userId };
  const total = await prisma.creditTransaction.count({ where });
  const pages = Math.max(1, Math.ceil(total / safePageSize));
  const currentPage = Math.min(safePage, pages - 1);
  const transactions = await prisma.creditTransaction.findMany({
    where,
    select: {
      amount: true,
      type: true,
      description: true,
      balanceAfter: true,
      createdAt: true,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    skip: currentPage * safePageSize,
    take: safePageSize,
  });

  return { transactions, total, page: currentPage, pages };
}

export interface CreditChangeOptions {
  userId: string;
  amount: number;
  type: CreditTransactionType;
  description: string;
  relatedEntityId?: string;
  batchId?: string;
}

export async function changeCredits(prisma: PrismaClient, options: CreditChangeOptions) {
  const { userId, amount, type, description } = options;
  if (!Number.isSafeInteger(amount) || amount === 0) {
    throw new ValidationError("Credit changes must be a non-zero whole number.");
  }
  if (Math.abs(amount) > MAX_CREDITS || description.length > 500) {
    throw new ValidationError("That credit change is outside the allowed limit.");
  }

  return prisma.$transaction(async (tx) => {
    const where = amount > 0
      ? { id: userId, credits: { lte: MAX_CREDITS - amount } }
      : { id: userId, credits: { gte: -amount } };
    const changed = await tx.user.updateMany({
      where,
      data: { credits: { increment: amount } },
    });
    if (changed.count === 0) {
      const current = await tx.user.findUnique({ where: { id: userId }, select: { credits: true } });
      if (!current) throw new NotFoundError("That user isn't in Iris yet.");
      if (amount < 0) throw new InsufficientCreditsError("That user doesn't have that many credits.");
      throw new ValidationError("That user would exceed the maximum credit balance.");
    }

    const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
    await tx.creditTransaction.create({
      data: {
        id: randomUUID(),
        userId,
        amount,
        type,
        description,
        balanceAfter: user.credits,
        ...(options.relatedEntityId ? { relatedEntityId: options.relatedEntityId } : {}),
        ...(options.batchId ? { batchId: options.batchId } : {}),
      },
    });
    return user;
  }, { isolationLevel: "ReadCommitted", maxWait: 5_000, timeout: 15_000 });
}

export async function giftCredits(
  prisma: PrismaClient,
  telegramId: number | bigint,
  credits: number,
  description = "Owner credit gift",
) {
  if (!Number.isSafeInteger(credits) || credits <= 0) throw new ValidationError("Gift credits must be positive.");
  const user = await prisma.user.findUnique({ where: { telegramId: BigInt(telegramId) } });
  if (!user) throw new NotFoundError("That Telegram user has not started Iris yet.");
  return changeCredits(prisma, {
    userId: user.id,
    amount: credits,
    type: "GIFT",
    description,
  });
}

export async function removeCredits(
  prisma: PrismaClient,
  telegramId: number | bigint,
  credits: number,
) {
  if (!Number.isSafeInteger(credits) || credits <= 0) throw new ValidationError("Removed credits must be positive.");
  const user = await prisma.user.findUnique({ where: { telegramId: BigInt(telegramId) } });
  if (!user) throw new NotFoundError("That Telegram user has not started Iris yet.");
  return changeCredits(prisma, {
    userId: user.id,
    amount: -credits,
    type: "ADMIN_ADJUSTMENT",
    description: "Owner removed credits",
  });
}

export async function giftAllActiveUsers(
  prisma: PrismaClient,
  credits: number,
  activeHours = 72,
): Promise<{ recipients: number; skipped: number; batchId: string }> {
  if (!Number.isSafeInteger(credits) || credits <= 0 || credits > MAX_CREDITS) {
    throw new ValidationError("Gift amount must be a positive whole number.");
  }
  if (!Number.isSafeInteger(activeHours) || activeHours < 1 || activeHours > 720) {
    throw new ValidationError("The activity window is invalid.");
  }

  const batchId = randomUUID();
  const result = await prisma.$transaction(async (tx) => {
    const timeRows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    const now = timeRows[0]?.now;
    if (!now) throw new Error("PostgreSQL did not return its current time.");
    const cutoff = new Date(now.getTime() - activeHours * 60 * 60 * 1_000);
    const eligible = await tx.$queryRaw<Array<{ id: string; credits: number }>>`
      SELECT id, credits
      FROM users
      WHERE last_active_at >= ${cutoff}
      ORDER BY id
      FOR UPDATE
    `;
    const recipients = eligible.filter((user) => user.credits <= MAX_CREDITS - credits);
    const skipped = eligible.length - recipients.length;
    if (!recipients.length) return { recipients: 0, skipped, batchId };

    await tx.user.updateMany({
      where: { id: { in: recipients.map((user) => user.id) } },
      data: { credits: { increment: credits } },
    });
    await tx.creditTransaction.createMany({
      data: recipients.map((user) => ({
        id: randomUUID(),
        userId: user.id,
        amount: credits,
        type: "GIFT_ALL",
        description: `Owner gift to active users (${activeHours}h window)`,
        batchId,
        balanceAfter: user.credits + credits,
        createdAt: now,
      })),
    });
    return { recipients: recipients.length, skipped, batchId };
  }, { isolationLevel: "ReadCommitted", maxWait: 5_000, timeout: 30_000 });

  return result;
}
