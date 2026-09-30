import type { Api } from "grammy";
import { GrammyError } from "grammy";
import type { PrismaClient } from "../generated/prisma/client.js";

const PAGE_SIZE = 200;
const MIN_SEND_GAP_MS = 40;

export interface BroadcastProgress {
  processed: number;
  total: number;
  delivered: number;
  failed: number;
}

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function broadcastToUsers(
  prisma: PrismaClient,
  api: Api,
  text: string,
  onProgress?: (progress: BroadcastProgress) => Promise<void>,
): Promise<BroadcastProgress> {
  const total = await prisma.user.count({ where: { isBlocked: false } });
  const progress: BroadcastProgress = { processed: 0, total, delivered: 0, failed: 0 };
  let skip = 0;
  let lastSentAt = 0;
  const newlyBlocked: string[] = [];

  while (true) {
    const users = await prisma.user.findMany({
      where: { isBlocked: false },
      select: { id: true, telegramId: true },
      orderBy: { id: "asc" },
      skip,
      take: PAGE_SIZE,
    });
    if (!users.length) break;

    for (const user of users) {
      const delay = MIN_SEND_GAP_MS - (Date.now() - lastSentAt);
      if (delay > 0) await sleep(delay);
      let delivered = false;
      let attempts = 0;
      while (!delivered && attempts < 3) {
        attempts += 1;
        try {
          await api.sendMessage(Number(user.telegramId), text, { link_preview_options: { is_disabled: true } });
          delivered = true;
          progress.delivered += 1;
        } catch (error) {
          if (error instanceof GrammyError && error.parameters.retry_after && attempts < 3) {
            await sleep(error.parameters.retry_after * 1_000 + 150);
            continue;
          }
          progress.failed += 1;
          if (error instanceof GrammyError && error.error_code === 403) newlyBlocked.push(user.id);
          break;
        } finally {
          lastSentAt = Date.now();
        }
      }
      progress.processed += 1;
      if (onProgress && (progress.processed % 100 === 0 || progress.processed === progress.total)) {
        await onProgress({ ...progress });
      }
    }
    skip += users.length;
    if (users.length < PAGE_SIZE) break;
  }
  if (newlyBlocked.length) {
    await prisma.user.updateMany({ where: { id: { in: newlyBlocked } }, data: { isBlocked: true } });
  }
  return progress;
}
