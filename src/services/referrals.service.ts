import { randomUUID } from "node:crypto";
import type { User as TelegramUser } from "grammy/types";
import type { PrismaClient, User } from "../generated/prisma/client.js";
import { MAX_CREDITS } from "./credits.service.js";
import { getReferralSettings, type ReferralSettings } from "./settings.service.js";
import { touchUser } from "./users.service.js";

export type ReferralIgnoreReason =
  | "disabled"
  | "self_referral"
  | "already_registered"
  | "referrer_not_found"
  | "referrer_blocked"
  | "invalid_payload";

export interface StartReferralResult {
  user: User;
  isNewUser: boolean;
  referralApplied: boolean;
  referralIgnoreReason?: ReferralIgnoreReason;
  referrer?: {
    id: string;
    telegramId: bigint;
    firstName: string | null;
    username: string | null;
    creditsAwarded: number;
    balanceAfter: number;
  };
  inviteeCreditsAwarded: number;
}

export function buildReferralStartPayload(telegramId: number | bigint): string {
  return `ref_${telegramId.toString()}`;
}

export function buildReferralLink(
  botUsername: string | undefined,
  telegramId: number | bigint,
): string {
  const cleanUsername = (botUsername?.trim().replace(/^@/, "") || "IrisStoreBot");
  return `https://t.me/${cleanUsername}?start=${buildReferralStartPayload(telegramId)}`;
}

export function buildReferralShareUrl(
  referralLink: string,
  inviteeCredits: number,
): string {
  const shareText = inviteeCredits > 0
    ? `✨ Join Iris Digital Store using my invite link and get +${inviteeCredits} free welcome credits instantly!`
    : `✨ Join Iris Digital Store using my invite link for instant digital goods and daily credits!`;
  return `https://t.me/share/url?url=${encodeURIComponent(referralLink)}&text=${encodeURIComponent(shareText)}`;
}

export function parseReferralStartPayload(rawPayload: string): bigint | null {
  const trimmed = rawPayload.trim();
  if (!trimmed) return null;
  const match = /^(?:ref_|r_)([1-9]\d{0,15})$/i.exec(trimmed);
  if (!match?.[1]) return null;
  const parsed = BigInt(match[1]);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return parsed;
}

function formatUserLabel(user: {
  username?: string | null;
  firstName?: string | null;
  telegramId: bigint;
}): string {
  if (user.username) return `@${user.username}`;
  if (user.firstName?.trim()) return user.firstName.trim();
  return `User ${user.telegramId.toString()}`;
}

export async function processReferralStart(
  prisma: PrismaClient,
  telegramUser: TelegramUser,
  rawStartPayload = "",
  defaultSettings: Partial<ReferralSettings> = {},
): Promise<StartReferralResult> {
  const trimmedPayload = rawStartPayload.trim();
  if (!trimmedPayload) {
    const user = await touchUser(prisma, telegramUser);
    return {
      user,
      isNewUser: false,
      referralApplied: false,
      inviteeCreditsAwarded: 0,
    };
  }

  const telegramId = BigInt(telegramUser.id);
  const referrerTelegramId = parseReferralStartPayload(trimmedPayload);
  const now = new Date();
  const profile = {
    username: telegramUser.username ?? null,
    firstName: telegramUser.first_name ?? null,
    lastName: telegramUser.last_name ?? null,
    lastActiveAt: now,
  };

  try {
    return await prisma.$transaction(async (tx) => {
      const existing = await tx.user.findUnique({ where: { telegramId } });
      if (existing) {
        const updated = await tx.user.update({
          where: { id: existing.id },
          data: profile,
        });
        const ignoreReason: ReferralIgnoreReason = !referrerTelegramId
          ? "invalid_payload"
          : referrerTelegramId === telegramId
            ? "self_referral"
            : "already_registered";
        return {
          user: updated,
          isNewUser: false,
          referralApplied: false,
          referralIgnoreReason: ignoreReason,
          inviteeCreditsAwarded: 0,
        };
      }

      if (!referrerTelegramId) {
        const created = await tx.user.create({
          data: { telegramId, ...profile },
        });
        return {
          user: created,
          isNewUser: true,
          referralApplied: false,
          referralIgnoreReason: "invalid_payload",
          inviteeCreditsAwarded: 0,
        };
      }

      if (referrerTelegramId === telegramId) {
        const created = await tx.user.create({
          data: { telegramId, ...profile },
        });
        return {
          user: created,
          isNewUser: true,
          referralApplied: false,
          referralIgnoreReason: "self_referral",
          inviteeCreditsAwarded: 0,
        };
      }

      const settings = await getReferralSettings(tx, defaultSettings);
      if (!settings.enabled) {
        const created = await tx.user.create({
          data: { telegramId, ...profile },
        });
        return {
          user: created,
          isNewUser: true,
          referralApplied: false,
          referralIgnoreReason: "disabled",
          inviteeCreditsAwarded: 0,
        };
      }

      const referrerRows = await tx.$queryRaw<
        Array<{
          id: string;
          telegram_id: bigint;
          username: string | null;
          first_name: string | null;
          credits: number;
          is_blocked: boolean;
        }>
      >`
        SELECT id, telegram_id, username, first_name, credits, is_blocked
        FROM users
        WHERE telegram_id = ${referrerTelegramId}
        FOR UPDATE
      `;
      const referrer = referrerRows[0];
      if (!referrer) {
        const created = await tx.user.create({
          data: { telegramId, ...profile },
        });
        return {
          user: created,
          isNewUser: true,
          referralApplied: false,
          referralIgnoreReason: "referrer_not_found",
          inviteeCreditsAwarded: 0,
        };
      }

      if (referrer.is_blocked) {
        const created = await tx.user.create({
          data: { telegramId, ...profile },
        });
        return {
          user: created,
          isNewUser: true,
          referralApplied: false,
          referralIgnoreReason: "referrer_blocked",
          inviteeCreditsAwarded: 0,
        };
      }

      const referrerReward = Math.max(
        0,
        Math.min(settings.referrerCredits, MAX_CREDITS - referrer.credits),
      );
      const inviteeReward = Math.max(0, Math.min(settings.inviteeCredits, MAX_CREDITS));

      const created = await tx.user.create({
        data: {
          telegramId,
          ...profile,
          credits: inviteeReward,
          referredById: referrer.id,
          referredAt: now,
          referralRewardCredits: referrerReward,
          referralWelcomeCredits: inviteeReward,
        },
      });

      const referrerLabel = formatUserLabel({
        username: referrer.username,
        firstName: referrer.first_name,
        telegramId: referrer.telegram_id,
      });
      const inviteeLabel = formatUserLabel({
        username: created.username,
        firstName: created.firstName,
        telegramId: created.telegramId,
      });

      if (inviteeReward > 0) {
        await tx.creditTransaction.create({
          data: {
            id: randomUUID(),
            userId: created.id,
            amount: inviteeReward,
            type: "REFERRAL",
            description: `Referral welcome bonus · invited by ${referrerLabel}`.slice(0, 500),
            relatedEntityId: referrer.id,
            batchId: `ref_welcome:${created.id}`,
            balanceAfter: inviteeReward,
            createdAt: now,
          },
        });
      }

      let referrerBalanceAfter = referrer.credits;
      if (referrerReward > 0) {
        const updatedReferrer = await tx.user.update({
          where: { id: referrer.id },
          data: { credits: { increment: referrerReward } },
        });
        referrerBalanceAfter = updatedReferrer.credits;
        await tx.creditTransaction.create({
          data: {
            id: randomUUID(),
            userId: referrer.id,
            amount: referrerReward,
            type: "REFERRAL",
            description: `Referral reward · invited ${inviteeLabel}`.slice(0, 500),
            relatedEntityId: created.id,
            batchId: `ref_reward:${created.id}`,
            balanceAfter: referrerBalanceAfter,
            createdAt: now,
          },
        });
      }

      return {
        user: created,
        isNewUser: true,
        referralApplied: true,
        referrer: {
          id: referrer.id,
          telegramId: referrer.telegram_id,
          firstName: referrer.first_name,
          username: referrer.username,
          creditsAwarded: referrerReward,
          balanceAfter: referrerBalanceAfter,
        },
        inviteeCreditsAwarded: inviteeReward,
      };
    }, { isolationLevel: "ReadCommitted", maxWait: 5_000, timeout: 15_000 });
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "P2002") {
      const user = await touchUser(prisma, telegramUser);
      return {
        user,
        isNewUser: false,
        referralApplied: false,
        referralIgnoreReason: "already_registered",
        inviteeCreditsAwarded: 0,
      };
    }
    throw error;
  }
}

export interface UserReferralSummary {
  totalReferrals: number;
  totalEarned: number;
  referredBy: {
    id: string;
    telegramId: bigint;
    username: string | null;
    firstName: string | null;
  } | null;
  referralWelcomeCredits: number;
}

export async function getUserReferralSummary(
  prisma: PrismaClient,
  userId: string,
): Promise<UserReferralSummary> {
  const [aggregate, userRecord] = await Promise.all([
    prisma.user.aggregate({
      where: { referredById: userId },
      _count: { _all: true },
      _sum: { referralRewardCredits: true },
    }),
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        referralWelcomeCredits: true,
        referredBy: {
          select: {
            id: true,
            telegramId: true,
            username: true,
            firstName: true,
          },
        },
      },
    }),
  ]);

  return {
    totalReferrals: aggregate._count._all,
    totalEarned: aggregate._sum.referralRewardCredits ?? 0,
    referredBy: userRecord?.referredBy ?? null,
    referralWelcomeCredits: userRecord?.referralWelcomeCredits ?? 0,
  };
}

export async function listUserReferrals(
  prisma: PrismaClient,
  userId: string,
  page = 0,
  pageSize = 8,
) {
  const safePage = Number.isSafeInteger(page) ? Math.max(0, page) : 0;
  const safePageSize = Number.isSafeInteger(pageSize)
    ? Math.max(1, Math.min(25, pageSize))
    : 8;
  const where = { referredById: userId };
  const [aggregate, referrals] = await Promise.all([
    prisma.user.aggregate({
      where,
      _count: { _all: true },
      _sum: { referralRewardCredits: true },
    }),
    prisma.user.findMany({
      where,
      select: {
        id: true,
        telegramId: true,
        username: true,
        firstName: true,
        lastName: true,
        referredAt: true,
        createdAt: true,
        referralRewardCredits: true,
      },
      orderBy: [{ referredAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    }),
  ]);

  const total = aggregate._count._all;
  const totalEarned = aggregate._sum.referralRewardCredits ?? 0;
  const pages = Math.max(1, Math.ceil(total / safePageSize));
  const currentPage = Math.min(safePage, pages - 1);
  const pageItems = referrals.slice(currentPage * safePageSize, (currentPage + 1) * safePageSize);

  return {
    referrals: pageItems,
    total,
    totalEarned,
    page: currentPage,
    pages,
  };
}
