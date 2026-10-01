BEGIN;

-- Persist the delivery group and its item order independently of request-key suffixes.
ALTER TABLE "purchases"
ADD COLUMN "batch_id" TEXT,
ADD COLUMN "batch_index" INTEGER NOT NULL DEFAULT 0;

-- Every historical single-item purchase is initially its own delivery group.
UPDATE "purchases" SET "batch_id" = "id";

-- Old bulk transactions used the root request key followed by :1 through :9.
-- Only group rows with the same buyer, product, and transaction timestamp, and
-- require a matching purchase ledger entry on the root. A row with its own
-- ledger entry is a separate checkout, not a child of a similarly named key.
WITH legacy_roots AS (
  SELECT root.*
  FROM "purchases" AS root
  WHERE EXISTS (
    SELECT 1
    FROM "credit_transactions" AS ledger
    WHERE ledger."type" = 'PURCHASE'
      AND ledger."related_entity_id" = root."id"
      AND ledger."user_id" = root."buyer_id"
  )
), legacy_items AS (
  SELECT child."id", root."id" AS "batch_id", item_index AS "batch_index", child."amount_paid"
  FROM legacy_roots AS root
  CROSS JOIN generate_series(1, 9) AS item_index
  JOIN "purchases" AS child
    ON (
      child."idempotency_key" = root."idempotency_key" || ':' || item_index::text
      OR (
        item_index = 1
        AND char_length(root."idempotency_key") = 127
        AND child."idempotency_key" = root."idempotency_key" || ':'
      )
    )
    AND child."buyer_id" = root."buyer_id"
    AND child."product_id" = root."product_id"
    AND child."created_at" = root."created_at"
  WHERE NOT EXISTS (
    SELECT 1 FROM legacy_roots AS separate_root WHERE separate_root."id" = child."id"
  )
), legacy_totals AS (
  SELECT "batch_id", COUNT(*) AS item_count, MAX("batch_index") AS last_index,
         SUM("amount_paid") AS child_total
  FROM legacy_items
  GROUP BY "batch_id"
)
UPDATE "purchases" AS purchase
SET "batch_id" = legacy_items."batch_id",
    "batch_index" = legacy_items."batch_index"
FROM legacy_items
JOIN legacy_totals ON legacy_totals."batch_id" = legacy_items."batch_id"
JOIN legacy_roots AS root ON root."id" = legacy_items."batch_id"
WHERE purchase."id" = legacy_items."id"
  -- Contiguous item positions and the original ledger debit must both agree.
  AND legacy_totals.item_count = legacy_totals.last_index
  AND EXISTS (
    SELECT 1 FROM "credit_transactions" AS ledger
    WHERE ledger."type" = 'PURCHASE'
      AND ledger."related_entity_id" = root."id"
      AND ledger."user_id" = root."buyer_id"
      AND ledger."amount" = -(root."amount_paid" + legacy_totals.child_total)
  );

ALTER TABLE "purchases" ALTER COLUMN "batch_id" SET NOT NULL;

CREATE UNIQUE INDEX "purchases_batch_id_batch_index_key"
ON "purchases"("batch_id", "batch_index");

COMMIT;
