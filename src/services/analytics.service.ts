import type { PrismaClient } from "../generated/prisma/client.js";

export async function getStoreStatistics(prisma: PrismaClient) {
  const [timeRows, users, referrals, active24h, active72h, products, inventory, purchases, creditTotals, recentPurchases] = await Promise.all([
    prisma.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`,
    prisma.user.count(),
    prisma.user.count({ where: { referredById: { not: null } } }),
    prisma.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*)::bigint AS count FROM users WHERE last_active_at >= NOW() - INTERVAL '24 hours'`,
    prisma.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*)::bigint AS count FROM users WHERE last_active_at >= NOW() - INTERVAL '72 hours'`,
    prisma.product.count({ where: { deletedAt: null } }),
    prisma.inventoryItem.count({ where: { status: "AVAILABLE" } }),
    prisma.purchase.count(),
    prisma.creditTransaction.groupBy({ by: ["type"], _sum: { amount: true } }),
    prisma.purchase.findMany({
      take: 8,
      orderBy: { createdAt: "desc" },
      include: {
        buyer: { select: { telegramId: true, username: true, firstName: true } },
        product: { select: { name: true, emoji: true } },
      },
    }),
  ]);

  const issuedTypes = new Set(["BONUS", "GIFT", "GIFT_ALL", "REDEEM", "REFUND", "ADMIN_ADJUSTMENT", "REFERRAL"]);
  const totals = new Map(creditTotals.map((row) => [row.type, row._sum.amount ?? 0]));
  const creditsIssued = [...totals.entries()]
    .filter(([type]) => issuedTypes.has(type))
    .reduce((sum, [, amount]) => sum + amount, 0);
  const creditsSpent = Math.abs(totals.get("PURCHASE") ?? 0);
  return {
    now: timeRows[0]?.now ?? new Date(),
    users,
    referrals,
    active24h: Number(active24h[0]?.count ?? 0n),
    active72h: Number(active72h[0]?.count ?? 0n),
    products,
    inventory,
    purchases,
    creditsIssued,
    creditsSpent,
    recentPurchases,
  };
}

export async function listUsersPage(prisma: PrismaClient, page: number, pageSize = 8) {
  const skip = Math.max(0, page) * pageSize;
  const [users, total] = await Promise.all([
    prisma.user.findMany({
      orderBy: { lastActiveAt: "desc" },
      skip,
      take: pageSize,
      select: {
        id: true,
        telegramId: true,
        username: true,
        firstName: true,
        credits: true,
        createdAt: true,
        lastActiveAt: true,
      },
    }),
    prisma.user.count(),
  ]);
  return { users, total, pages: Math.max(1, Math.ceil(total / pageSize)) };
}
