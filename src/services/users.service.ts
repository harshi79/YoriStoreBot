import type { User as TelegramUser } from "grammy/types";
import type { PrismaClient } from "../generated/prisma/client.js";
import { NotFoundError } from "../utils/errors.js";

export async function touchUser(prisma: PrismaClient, telegramUser: TelegramUser) {
  const telegramId = BigInt(telegramUser.id);
  const profile = {
    username: telegramUser.username ?? null,
    firstName: telegramUser.first_name ?? null,
    lastName: telegramUser.last_name ?? null,
    lastActiveAt: new Date(),
  };
  return prisma.user.upsert({
    where: { telegramId },
    create: {
      telegramId,
      ...profile,
    },
    update: profile,
  });
}

export async function findUserByTelegramId(prisma: PrismaClient, telegramId: number | bigint) {
  const user = await prisma.user.findUnique({ where: { telegramId: BigInt(telegramId) } });
  if (!user) throw new NotFoundError("Your Iris profile is not ready yet. Send /start first.");
  return user;
}

export async function saveProfilePhoto(
  prisma: PrismaClient,
  telegramId: number | bigint,
  fileId: string | null,
): Promise<void> {
  await prisma.user.updateMany({
    where: { telegramId: BigInt(telegramId) },
    data: { profilePhotoFileId: fileId },
  });
}

export async function countUserPurchases(prisma: PrismaClient, userId: string): Promise<number> {
  return prisma.purchase.count({ where: { buyerId: userId } });
}
