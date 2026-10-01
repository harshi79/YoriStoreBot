import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { PrismaPGlite } from "pglite-prisma-adapter";
import { describe, expect, it } from "vitest";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { purchaseProduct } from "../src/services/purchases.service.js";

const initialMigration = new URL("../prisma/migrations/20260930000000_init/migration.sql", import.meta.url);
const batchMigration = new URL("../prisma/migrations/20261002000000_purchase_batches/migration.sql", import.meta.url);
const checkoutTime = "2026-10-01T12:00:00.000Z";

interface LegacyPurchase {
  id: string;
  key: string;
  buyer?: string;
  product?: string;
  price?: number;
  createdAt?: string;
  ledgerAmount?: number;
}

async function insertLegacyPurchase(pg: PGlite, input: LegacyPurchase) {
  const buyer = input.buyer ?? "buyer";
  const product = input.product ?? "product";
  const price = input.price ?? 40;
  const createdAt = input.createdAt ?? checkoutTime;
  await pg.query(
    `INSERT INTO inventory_items (id, product_id, payload, payload_hash, status, purchaser_id, purchased_at)
     VALUES ($1, $2, $3, $4, 'SOLD', $5, $6)`,
    [`stock-${input.id}`, product, `payload-${input.id}`, input.id.padEnd(64, "x"), buyer, createdAt],
  );
  await pg.query(
    `INSERT INTO purchases (id, buyer_id, product_id, inventory_item_id, idempotency_key, amount_paid, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [input.id, buyer, product, `stock-${input.id}`, input.key, price, createdAt],
  );
  if (input.ledgerAmount !== undefined) {
    await pg.query(
      `INSERT INTO credit_transactions
       (id, user_id, amount, type, description, related_entity_id, balance_after, created_at)
       VALUES ($1, $2, $3, 'PURCHASE', 'Historical checkout', $4, 500, $5)`,
      [`ledger-${input.id}`, buyer, input.ledgerAmount, input.id, createdAt],
    );
  }
}

describe("purchase batch migration", () => {
  it("preserves historical purchases and safely groups legacy bulk, free, and truncated-key deliveries", async () => {
    const pg = new PGlite();
    let prisma: PrismaClient | undefined;
    try {
      await pg.exec(await readFile(initialMigration, "utf8"));
      await pg.exec(`
        INSERT INTO users (id, telegram_id, credits, updated_at)
        VALUES ('buyer', 10001, 500, CURRENT_TIMESTAMP), ('other-buyer', 10002, 500, CURRENT_TIMESTAMP);
        INSERT INTO categories (id, name, updated_at) VALUES ('category', 'Catalog', CURRENT_TIMESTAMP);
        INSERT INTO products (id, category_id, name, price, updated_at)
        VALUES ('product', 'category', 'Legacy bulk product', 40, CURRENT_TIMESTAMP),
               ('other-product', 'category', 'Different product', 40, CURRENT_TIMESTAMP),
               ('free-product', 'category', 'Free product', 0, CURRENT_TIMESTAMP);
      `);
      const longKey = "k".repeat(127);
      const fixtures: LegacyPurchase[] = [
        { id: "bulk-root", key: "legacy-bulk", ledgerAmount: -120 },
        { id: "bulk-one", key: "legacy-bulk:1" },
        { id: "bulk-two", key: "legacy-bulk:2" },
        // Similar keys alone are never enough to group independent purchases.
        { id: "separate-checkout", key: "legacy-bulk:3", ledgerAmount: -40 },
        { id: "other-buyer-item", key: "legacy-bulk:4", buyer: "other-buyer" },
        { id: "other-product-item", key: "legacy-bulk:5", product: "other-product" },
        { id: "different-time-item", key: "legacy-bulk:6", createdAt: "2026-10-01T12:00:01.000Z" },
        { id: "standalone", key: "legacy-single" },
        { id: "single-root", key: "single-with-lookalike", ledgerAmount: -40 },
        { id: "lookalike", key: "single-with-lookalike:1" },
        { id: "free-root", key: "legacy-free", product: "free-product", price: 0, ledgerAmount: 0 },
        { id: "free-one", key: "legacy-free:1", product: "free-product", price: 0 },
        { id: "free-two", key: "legacy-free:2", product: "free-product", price: 0 },
        { id: "long-root", key: longKey, ledgerAmount: -80 },
        { id: "long-child", key: `${longKey}:` },
      ];
      for (const fixture of fixtures) await insertLegacyPurchase(pg, fixture);
      const originalRows = await pg.query("SELECT id, idempotency_key, amount_paid, inventory_item_id FROM purchases ORDER BY id");
      await pg.exec(await readFile(batchMigration, "utf8"));
      expect((await pg.query("SELECT id, idempotency_key, amount_paid, inventory_item_id FROM purchases ORDER BY id")).rows)
        .toEqual(originalRows.rows);

      const grouped = await pg.query<{ id: string; batch_id: string; batch_index: number }>(
        "SELECT id, batch_id, batch_index FROM purchases ORDER BY id",
      );
      for (const fixture of fixtures) {
        const row = grouped.rows.find((item) => item.id === fixture.id);
        const expected = fixture.id === "bulk-one" ? ["bulk-root", 1]
          : fixture.id === "bulk-two" ? ["bulk-root", 2]
          : fixture.id === "free-one" ? ["free-root", 1]
          : fixture.id === "free-two" ? ["free-root", 2]
          : fixture.id === "long-child" ? ["long-root", 1]
          : [fixture.id, 0];
        expect(row).toMatchObject({ batch_id: expected[0], batch_index: expected[1] });
      }

      prisma = new PrismaClient({ adapter: new PrismaPGlite(pg) });
      const replay = await purchaseProduct(prisma, "buyer", "product", "legacy-bulk");
      expect(replay).toMatchObject({
        purchaseId: "bulk-root", quantity: 3, paid: 120, remainingCredits: 500, repeated: true,
        payloads: ["payload-bulk-root", "payload-bulk-one", "payload-bulk-two"],
      });
      expect(await purchaseProduct(prisma, "buyer", "free-product", "legacy-free"))
        .toMatchObject({ quantity: 3, paid: 0, repeated: true });
      expect(await purchaseProduct(prisma, "buyer", "product", longKey))
        .toMatchObject({ quantity: 2, paid: 80, repeated: true });
      expect(await purchaseProduct(prisma, "buyer", "product", "legacy-single"))
        .toMatchObject({ quantity: 1, paid: 40, repeated: true });
      expect(await prisma.purchase.count()).toBe(fixtures.length);
      expect(await prisma.creditTransaction.count()).toBe(5);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: "buyer" } })).credits).toBe(500);

      await expect(pg.query("UPDATE purchases SET batch_id = 'bulk-root', batch_index = 0 WHERE id = 'standalone'"))
        .rejects.toThrow(/unique|duplicate/i);
      await expect(pg.query("UPDATE purchases SET batch_id = NULL WHERE id = 'standalone'"))
        .rejects.toThrow(/not-null|null value/i);
    } finally {
      await prisma?.$disconnect();
      await pg.close();
    }
  }, 30_000);
});
