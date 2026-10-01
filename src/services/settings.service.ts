import type { Prisma, PrismaClient } from "../generated/prisma/client.js";
import { ValidationError } from "../utils/errors.js";

export interface BonusSettings {
  credits: number;
  periodHours: number;
}

export interface ReferralSettings {
  enabled: boolean;
  referrerCredits: number;
  inviteeCredits: number;
}

export const DEFAULT_REFERRAL_SETTINGS: ReferralSettings = {
  enabled: true,
  referrerCredits: 10,
  inviteeCredits: 5,
};

export async function getBonusSettings(
  prisma: PrismaClient | Prisma.TransactionClient,
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

export async function getReferralSettings(
  prisma: PrismaClient | Prisma.TransactionClient,
  defaults: Partial<ReferralSettings> = {},
): Promise<ReferralSettings> {
  const fallback: ReferralSettings = {
    enabled: defaults.enabled ?? DEFAULT_REFERRAL_SETTINGS.enabled,
    referrerCredits: defaults.referrerCredits ?? DEFAULT_REFERRAL_SETTINGS.referrerCredits,
    inviteeCredits: defaults.inviteeCredits ?? DEFAULT_REFERRAL_SETTINGS.inviteeCredits,
  };
  const values = await prisma.appSetting.findMany({
    where: {
      key: {
        in: ["referral_enabled", "referral_referrer_credits", "referral_invitee_credits"],
      },
    },
  });
  const byKey = new Map(values.map((item) => [item.key, item.value]));
  const rawEnabled = byKey.get("referral_enabled");
  const enabled = rawEnabled === undefined ? fallback.enabled : rawEnabled === "true";
  const referrerCredits = Number(byKey.get("referral_referrer_credits") ?? fallback.referrerCredits);
  const inviteeCredits = Number(byKey.get("referral_invitee_credits") ?? fallback.inviteeCredits);
  return {
    enabled,
    referrerCredits:
      Number.isSafeInteger(referrerCredits) && referrerCredits >= 0 && referrerCredits <= 1_000_000
        ? referrerCredits
        : fallback.referrerCredits,
    inviteeCredits:
      Number.isSafeInteger(inviteeCredits) && inviteeCredits >= 0 && inviteeCredits <= 1_000_000
        ? inviteeCredits
        : fallback.inviteeCredits,
  };
}

export async function updateReferralSettings(
  prisma: PrismaClient,
  settings: Pick<ReferralSettings, "referrerCredits" | "inviteeCredits"> & { enabled?: boolean },
): Promise<void> {
  if (!Number.isSafeInteger(settings.referrerCredits) || settings.referrerCredits < 0 || settings.referrerCredits > 1_000_000) {
    throw new ValidationError("Referrer reward credits must be a whole number from 0 to 1,000,000.");
  }
  if (!Number.isSafeInteger(settings.inviteeCredits) || settings.inviteeCredits < 0 || settings.inviteeCredits > 1_000_000) {
    throw new ValidationError("Friend welcome bonus must be a whole number from 0 to 1,000,000.");
  }
  if (settings.referrerCredits === 0 && settings.inviteeCredits === 0) {
    throw new ValidationError("At least one referral reward (referrer or welcome bonus) must be greater than 0.");
  }
  await prisma.$transaction([
    prisma.appSetting.upsert({
      where: { key: "referral_referrer_credits" },
      create: { key: "referral_referrer_credits", value: String(settings.referrerCredits) },
      update: { value: String(settings.referrerCredits) },
    }),
    prisma.appSetting.upsert({
      where: { key: "referral_invitee_credits" },
      create: { key: "referral_invitee_credits", value: String(settings.inviteeCredits) },
      update: { value: String(settings.inviteeCredits) },
    }),
    ...(settings.enabled !== undefined
      ? [
          prisma.appSetting.upsert({
            where: { key: "referral_enabled" },
            create: { key: "referral_enabled", value: String(settings.enabled) },
            update: { value: String(settings.enabled) },
          }),
        ]
      : []),
  ]);
}

export async function toggleReferralEnabled(
  prisma: PrismaClient,
  defaults: Partial<ReferralSettings> = {},
): Promise<ReferralSettings> {
  const current = await getReferralSettings(prisma, defaults);
  const nextEnabled = !current.enabled;
  await prisma.appSetting.upsert({
    where: { key: "referral_enabled" },
    create: { key: "referral_enabled", value: String(nextEnabled) },
    update: { value: String(nextEnabled) },
  });
  return { ...current, enabled: nextEnabled };
}
