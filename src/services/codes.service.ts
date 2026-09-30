import { randomBytes, randomUUID } from "node:crypto";
import type { PrismaClient } from "../generated/prisma/client.js";
import { AlreadyRedeemedError, CodeUnavailableError, NotFoundError, ValidationError } from "../utils/errors.js";
import { MAX_CREDITS } from "./credits.service.js";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function randomCode(): string {
  const needed = 12;
  let result = "";
  while (result.length < needed) {
    for (const value of randomBytes(24)) {
      if (value >= 256 - (256 % CODE_ALPHABET.length)) continue;
      result += CODE_ALPHABET[value % CODE_ALPHABET.length];
      if (result.length === needed) break;
    }
  }
  return `IRIS-${result.slice(0, 4)}-${result.slice(4, 8)}-${result.slice(8, 12)}`;
}

export async function createRedeemCodes(
  prisma: PrismaClient,
  input: { amount: number; credits: number; maxRedeems: number; createdBy: bigint; expiresAt?: Date | null },
): Promise<string[]> {
  const { amount, credits, maxRedeems } = input;
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > 100) {
    throw new ValidationError("Generate between 1 and 100 codes at a time.");
  }
  if (!Number.isSafeInteger(credits) || credits < 1 || credits > MAX_CREDITS) {
    throw new ValidationError("Credits per redemption must be a positive whole number.");
  }
  if (!Number.isSafeInteger(maxRedeems) || maxRedeems < 1 || maxRedeems > 1_000_000) {
    throw new ValidationError("Max redeems must be between 1 and 1,000,000.");
  }
  if (input.expiresAt && input.expiresAt.getTime() <= Date.now()) {
    throw new ValidationError("Expiration must be in the future.");
  }

  const codes: string[] = [];
  const seen = new Set<string>();
  while (codes.length < amount) {
    const code = randomCode();
    if (!seen.has(code)) {
      seen.add(code);
      codes.push(code);
    }
  }
  await prisma.redeemCode.createMany({
    data: codes.map((code) => ({
      id: randomUUID(),
      code,
      creditAmount: credits,
      maxRedeems,
      createdBy: input.createdBy,
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    })),
  });
  return codes;
}

export async function redeemCode(
  prisma: PrismaClient,
  userId: string,
  rawCode: string,
): Promise<{ credits: number; balance: number; code: string }> {
  const code = rawCode.trim().toUpperCase();
  if (!/^IRIS-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code)) {
    throw new CodeUnavailableError();
  }
  try {
    return await prisma.$transaction(async (tx) => {
      const timeRows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
      const now = timeRows[0]?.now;
      if (!now) throw new Error("PostgreSQL did not return its current time.");
      const codeRow = await tx.redeemCode.findUnique({ where: { code } });
      if (!codeRow || !codeRow.enabled || (codeRow.expiresAt !== null && codeRow.expiresAt <= now)) {
        throw new CodeUnavailableError();
      }
      const previousRedemption = await tx.codeRedemption.findUnique({
        where: { redeemCodeId_userId: { redeemCodeId: codeRow.id, userId } },
      });
      if (previousRedemption) throw new AlreadyRedeemedError();
      if (codeRow.currentRedeems >= codeRow.maxRedeems) throw new CodeUnavailableError();
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) throw new NotFoundError("Send /start first so Iris can create your profile.");
      if (user.credits > MAX_CREDITS - codeRow.creditAmount) {
        throw new ValidationError("Your balance is at the maximum, so this code can't be applied.");
      }

      const redeemed = await tx.redeemCode.updateMany({
        where: {
          id: codeRow.id,
          enabled: true,
          currentRedeems: { lt: codeRow.maxRedeems },
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        data: { currentRedeems: { increment: 1 } },
      });
      if (!redeemed.count) {
        const previousRedemption = await tx.codeRedemption.findUnique({
          where: { redeemCodeId_userId: { redeemCodeId: codeRow.id, userId } },
        });
        if (previousRedemption) throw new AlreadyRedeemedError();
        throw new CodeUnavailableError();
      }
      await tx.codeRedemption.create({
        data: { id: randomUUID(), redeemCodeId: codeRow.id, userId, redeemedAt: now },
      });
      const balanceUpdate = await tx.user.updateMany({
        where: { id: userId, credits: { lte: MAX_CREDITS - codeRow.creditAmount } },
        data: { credits: { increment: codeRow.creditAmount } },
      });
      if (!balanceUpdate.count) throw new ValidationError("Your balance reached the maximum before this code could be applied.");
      const updated = await tx.user.findUniqueOrThrow({ where: { id: userId } });
      await tx.creditTransaction.create({
        data: {
          id: randomUUID(),
          userId,
          amount: codeRow.creditAmount,
          type: "REDEEM",
          description: `Redeemed ${code}`,
          relatedEntityId: codeRow.id,
          balanceAfter: updated.credits,
          createdAt: now,
        },
      });
      return { credits: codeRow.creditAmount, balance: updated.credits, code };
    }, { isolationLevel: "ReadCommitted", maxWait: 5_000, timeout: 15_000 });
  } catch (error) {
    if (isUniqueViolation(error)) throw new AlreadyRedeemedError();
    throw error;
  }
}

export async function listRedeemCodes(prisma: PrismaClient, skip = 0, take = 10) {
  return prisma.redeemCode.findMany({
    orderBy: { createdAt: "desc" },
    skip,
    take,
    include: { _count: { select: { redemptions: true } } },
  });
}

export async function setRedeemCodeEnabled(prisma: PrismaClient, codeId: string, enabled: boolean) {
  const result = await prisma.redeemCode.updateMany({ where: { id: codeId }, data: { enabled } });
  if (!result.count) throw new NotFoundError("That redeem code no longer exists.");
}

export function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === "P2002";
}
