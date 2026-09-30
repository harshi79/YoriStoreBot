import { randomUUID } from "node:crypto";
import type { PrismaClient } from "../generated/prisma/client.js";
import { BonusUnavailableError, NotFoundError, ValidationError } from "../utils/errors.js";
import { MAX_CREDITS } from "./credits.service.js";

export interface BonusResult {
  creditsReceived: number;
  balance: number;
  claimedAt: Date;
  nextAvailableAt: Date;
}

export async function claimDailyBonus(
  prisma: PrismaClient,
  userId: string,
  credits: number,
  periodHours: number,
): Promise<BonusResult> {
  if (!Number.isSafeInteger(credits) || credits < 1 || credits > MAX_CREDITS) {
    throw new ValidationError("Daily bonus configuration is invalid.");
  }
  if (!Number.isSafeInteger(periodHours) || periodHours < 1 || periodHours > 720) {
    throw new ValidationError("Daily bonus period is invalid.");
  }

  return prisma.$transaction(async (tx) => {
    const timeRows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    const now = timeRows[0]?.now;
    if (!now) throw new Error("PostgreSQL did not return its current time.");
    const cutoff = new Date(now.getTime() - periodHours * 60 * 60 * 1_000);
    const claimed = await tx.user.updateMany({
      where: {
        id: userId,
        credits: { lte: MAX_CREDITS - credits },
        OR: [{ dailyBonusAt: null }, { dailyBonusAt: { lte: cutoff } }],
      },
      data: {
        credits: { increment: credits },
        dailyBonusAt: now,
      },
    });
    if (claimed.count === 0) {
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { credits: true, dailyBonusAt: true },
      });
      if (!user) throw new NotFoundError("Send /start first so Iris can create your profile.");
      if (user.credits > MAX_CREDITS - credits) {
        throw new ValidationError("Your balance is at the maximum, so a bonus cannot be added.");
      }
      const nextAvailableAt = user.dailyBonusAt
        ? new Date(user.dailyBonusAt.getTime() + periodHours * 60 * 60 * 1_000)
        : new Date(now.getTime() + 1_000);
      throw new BonusUnavailableError(nextAvailableAt);
    }

    const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
    const nextAvailableAt = new Date(now.getTime() + periodHours * 60 * 60 * 1_000);
    await tx.creditTransaction.create({
      data: {
        id: randomUUID(),
        userId,
        amount: credits,
        type: "BONUS",
        description: `Daily bonus (${periodHours}h cooldown)`,
        balanceAfter: user.credits,
        createdAt: now,
      },
    });
    return {
      creditsReceived: credits,
      balance: user.credits,
      claimedAt: now,
      nextAvailableAt,
    };
  }, { isolationLevel: "ReadCommitted", maxWait: 5_000, timeout: 15_000 });
}

export async function getBonusStatus(
  prisma: PrismaClient,
  userId: string,
  periodHours: number,
): Promise<{ available: boolean; nextAvailableAt: Date | null; remainingMs: number }> {
  const [user, timeRows] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { dailyBonusAt: true } }),
    prisma.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`,
  ]);
  if (!user) throw new NotFoundError("Send /start first so Iris can create your profile.");
  const now = timeRows[0]?.now;
  if (!now) throw new Error("PostgreSQL did not return its current time.");
  if (!user.dailyBonusAt) return { available: true, nextAvailableAt: null, remainingMs: 0 };
  const nextAvailableAt = new Date(user.dailyBonusAt.getTime() + periodHours * 60 * 60 * 1_000);
  const remainingMs = Math.max(0, nextAvailableAt.getTime() - now.getTime());
  return { available: remainingMs === 0, nextAvailableAt, remainingMs };
}
