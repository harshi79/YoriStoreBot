import type { PrismaClient } from "../generated/prisma/client.js";
import { ValidationError } from "../utils/errors.js";

export interface BonusSettings {
  credits: number;
  periodHours: number;
}

export async function getBonusSettings(
  prisma: PrismaClient,
  defaults: BonusSettings,
): Promise<BonusSettings> {
  const values = await prisma.appSetting.findMany({
    where: { key: { in: ["bonus_credits", "bonus_period_hours"] } },
  });
  const byKey = new Map(values.map((item) => [item.key, item.value]));
  const credits = Number(byKey.get("bonus_credits") ?? defaults.credits);
  const periodHours = Number(byKey.get("bonus_period_hours") ?? defaults.periodHours);
  return {
    credits: Number.isSafeInteger(credits) && credits > 0 ? credits : defaults.credits,
    periodHours: Number.isSafeInteger(periodHours) && periodHours > 0 ? periodHours : defaults.periodHours,
  };
}

export async function updateBonusSettings(
  prisma: PrismaClient,
  settings: BonusSettings,
): Promise<void> {
  if (!Number.isSafeInteger(settings.credits) || settings.credits < 1 || settings.credits > 1_000_000) {
    throw new ValidationError("Bonus credits must be a whole number from 1 to 1,000,000.");
  }
  if (!Number.isSafeInteger(settings.periodHours) || settings.periodHours < 1 || settings.periodHours > 720) {
    throw new ValidationError("Bonus period must be from 1 to 720 hours.");
  }
  await prisma.$transaction([
    prisma.appSetting.upsert({
      where: { key: "bonus_credits" },
      create: { key: "bonus_credits", value: String(settings.credits) },
      update: { value: String(settings.credits) },
    }),
    prisma.appSetting.upsert({
      where: { key: "bonus_period_hours" },
      create: { key: "bonus_period_hours", value: String(settings.periodHours) },
      update: { value: String(settings.periodHours) },
    }),
  ]);
}
