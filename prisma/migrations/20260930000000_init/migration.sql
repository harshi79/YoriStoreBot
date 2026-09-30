CREATE TYPE "InventoryStatus" AS ENUM ('AVAILABLE', 'SOLD', 'REMOVED');
CREATE TYPE "CreditTransactionType" AS ENUM ('BONUS', 'GIFT', 'GIFT_ALL', 'REDEEM', 'PURCHASE', 'REFUND', 'ADMIN_ADJUSTMENT');

CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "telegram_id" BIGINT NOT NULL,
    "username" VARCHAR(64),
    "first_name" VARCHAR(128),
    "last_name" VARCHAR(128),
    "credits" INTEGER NOT NULL DEFAULT 0,
    "profile_photo_file_id" VARCHAR(512),
    "daily_bonus_at" TIMESTAMPTZ(6),
    "last_active_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "is_blocked" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "categories" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "description" VARCHAR(500) NOT NULL DEFAULT '',
    "emoji" VARCHAR(16) NOT NULL DEFAULT '◈',
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "products" (
    "id" TEXT NOT NULL,
    "category_id" TEXT NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(2000) NOT NULL DEFAULT '',
    "price" INTEGER NOT NULL,
    "emoji" VARCHAR(16) NOT NULL DEFAULT '✦',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "inventory_items" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "payload_hash" VARCHAR(64) NOT NULL,
    "status" "InventoryStatus" NOT NULL DEFAULT 'AVAILABLE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "purchased_at" TIMESTAMPTZ(6),
    "purchaser_id" TEXT,
    CONSTRAINT "inventory_items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "purchases" (
    "id" TEXT NOT NULL,
    "buyer_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "inventory_item_id" TEXT NOT NULL,
    "idempotency_key" VARCHAR(128) NOT NULL,
    "amount_paid" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "purchases_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "redeem_codes" (
    "id" TEXT NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "credit_amount" INTEGER NOT NULL,
    "max_redeems" INTEGER NOT NULL,
    "current_redeems" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_by" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6),
    CONSTRAINT "redeem_codes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "code_redemptions" (
    "id" TEXT NOT NULL,
    "redeem_code_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "redeemed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "code_redemptions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "credit_transactions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "type" "CreditTransactionType" NOT NULL,
    "description" VARCHAR(500) NOT NULL,
    "related_entity_id" VARCHAR(128),
    "batch_id" VARCHAR(64),
    "balance_after" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "credit_transactions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "reset_challenges" (
    "id" TEXT NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "owner_telegram_id" BIGINT NOT NULL,
    "stage" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    CONSTRAINT "reset_challenges_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "admin_audit" (
    "id" TEXT NOT NULL,
    "owner_telegram_id" BIGINT NOT NULL,
    "action" VARCHAR(80) NOT NULL,
    "details" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "admin_audit_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "app_settings" (
    "key" VARCHAR(80) NOT NULL,
    "value" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("key")
);

CREATE UNIQUE INDEX "users_telegram_id_key" ON "users"("telegram_id");
CREATE INDEX "users_last_active_at_idx" ON "users"("last_active_at");
CREATE INDEX "users_created_at_idx" ON "users"("created_at");
CREATE UNIQUE INDEX "categories_name_key" ON "categories"("name");
CREATE INDEX "categories_enabled_display_order_idx" ON "categories"("enabled", "display_order");
CREATE UNIQUE INDEX "products_category_id_name_key" ON "products"("category_id", "name");
CREATE INDEX "products_category_id_enabled_deleted_at_idx" ON "products"("category_id", "enabled", "deleted_at");
CREATE UNIQUE INDEX "inventory_items_product_id_payload_hash_key" ON "inventory_items"("product_id", "payload_hash");
CREATE INDEX "inventory_items_product_id_status_created_at_idx" ON "inventory_items"("product_id", "status", "created_at");
CREATE INDEX "inventory_items_purchaser_id_idx" ON "inventory_items"("purchaser_id");
CREATE UNIQUE INDEX "purchases_inventory_item_id_key" ON "purchases"("inventory_item_id");
CREATE UNIQUE INDEX "purchases_idempotency_key_key" ON "purchases"("idempotency_key");
CREATE INDEX "purchases_buyer_id_created_at_idx" ON "purchases"("buyer_id", "created_at");
CREATE INDEX "purchases_product_id_created_at_idx" ON "purchases"("product_id", "created_at");
CREATE UNIQUE INDEX "redeem_codes_code_key" ON "redeem_codes"("code");
CREATE INDEX "redeem_codes_enabled_expires_at_idx" ON "redeem_codes"("enabled", "expires_at");
CREATE UNIQUE INDEX "code_redemptions_redeem_code_id_user_id_key" ON "code_redemptions"("redeem_code_id", "user_id");
CREATE INDEX "code_redemptions_user_id_redeemed_at_idx" ON "code_redemptions"("user_id", "redeemed_at");
CREATE UNIQUE INDEX "credit_transactions_user_id_batch_id_key" ON "credit_transactions"("user_id", "batch_id");
CREATE INDEX "credit_transactions_user_id_created_at_idx" ON "credit_transactions"("user_id", "created_at");
CREATE INDEX "credit_transactions_type_created_at_idx" ON "credit_transactions"("type", "created_at");
CREATE UNIQUE INDEX "reset_challenges_token_hash_key" ON "reset_challenges"("token_hash");
CREATE INDEX "reset_challenges_expires_at_used_at_idx" ON "reset_challenges"("expires_at", "used_at");
CREATE INDEX "admin_audit_created_at_idx" ON "admin_audit"("created_at");

ALTER TABLE "products" ADD CONSTRAINT "products_category_id_fkey"
FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_product_id_fkey"
FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_purchaser_id_fkey"
FOREIGN KEY ("purchaser_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_buyer_id_fkey"
FOREIGN KEY ("buyer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_product_id_fkey"
FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_inventory_item_id_fkey"
FOREIGN KEY ("inventory_item_id") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "code_redemptions" ADD CONSTRAINT "code_redemptions_redeem_code_id_fkey"
FOREIGN KEY ("redeem_code_id") REFERENCES "redeem_codes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "code_redemptions" ADD CONSTRAINT "code_redemptions_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
