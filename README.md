# Iris — Telegram Credit Store Bot

Iris is a Node.js 22 / TypeScript Telegram bot for an owner-managed digital-goods store. It uses grammY, PostgreSQL, Prisma 7, and environment-based configuration. Store categories, products, inventory, redeem codes, balances, and the credit ledger are database-backed.

## Quick start

1. Install Node.js 22 and PostgreSQL, then install dependencies:

   ```sh
   npm ci
   ```

2. Copy `.env.example` to `.env` and edit it locally. Set the BotFather token and a PostgreSQL `DATABASE_URL`; keep `.env` out of version control. Do not send the bot token in chat or commit it.

3. Generate Prisma Client and apply the committed migration:

   ```sh
   npm run db:generate
   npm run db:deploy
   ```

   For local schema development, use `npm run db:migrate` instead of `db:deploy`.

4. Build and start the long-polling bot:

   ```sh
   npm run build
   npm start
   ```

   `npm run dev` runs the TypeScript entry point in watch mode. Iris verifies its database connection and Telegram credentials at startup, configures command menus, and gracefully closes polling and PostgreSQL on shutdown signals.

The sole authorized owner is fixed at Telegram ID `7728424218`; all owner commands, owner callbacks, and active owner form submissions are checked against that ID server-side, in addition to being restricted to private chats.

## Environment variables

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `BOT_TOKEN` | Yes | — | Telegram Bot API token from BotFather |
| `DATABASE_URL` | Yes at runtime | — | PostgreSQL connection URL |
| `NODE_ENV` | No | `development` | Runtime environment label |
| `LOG_LEVEL` | No | `info` | Pino log level |
| `BONUS_CREDITS` | No | `25` | Default daily bonus amount |
| `BONUS_PERIOD_HOURS` | No | `24` | Default bonus cooldown, 1–720 hours |
| `DATABASE_POOL_SIZE` | No | `10` | PostgreSQL connection pool size |
| `PM2_APP_NAME` | No | empty | Exact PM2 app name for the optional `/restart` command |

The bonus settings can also be changed from the owner panel; those overrides are stored in PostgreSQL. `/restart` only runs when `PM2_HOME` is present and Iris can verify the configured PM2 process. Otherwise, it explains that the host must restart the bot.

## User features

- `/start` sends Iris's welcome video (`https://imglink.cc/cdn/jw1NZXEQQS.mp4`) with a text fallback and inline navigation.
- `/store`, `/profile`, `/bonus`, `/redeem CODE`, `/orders`, and `/help` are available in private chats.
- Categories and products come from PostgreSQL; products show current stock and credit prices.
- Daily bonuses and code redemptions use conditional database updates and write matching credit-ledger rows in the same transaction.
- Purchases lock one available stock row, charge the buyer, mark inventory sold, write the purchase and ledger record atomically, and use an idempotency key to make callback retries safe. The delivery is returned only to the purchasing Telegram account.

## Owner features

Open `/admin` for inline management of categories, products, inventory, users, redeem codes, purchases, credit settings, statistics, exports, broadcast, restart, and reset. Available owner commands are `/gift USER_ID CREDITS`, `/rm USER_ID CREDITS`, `/giftall CREDITS`, `/code AMOUNT CREDITS MAXREDEEMS`, `/broadcast`, `/stats`, `/export`, `/addstock`, `/restart`, and `/reset`.

- Inventory can be entered as lines or imported from a `.txt`/`.csv` file (up to 1 MB, 500 items per batch, 3,500 characters per item). Duplicate stock values are skipped using a SHA-256 hash; stock payloads are not shown in admin list views.
- `/giftall` credits users active in the preceding 72 hours. Over-limit balances are skipped and reported.
- Broadcasts are previewed and explicitly confirmed, sent with a conservative inter-message delay, retried on Telegram rate-limit responses, counted, and users who return `403` are marked blocked.
- `/export` creates a structured JSON backup of user profiles and balances, catalog, inventory, codes and redemptions, purchases, credit history, settings, and admin audit entries. The file contains private inventory values and user data; store it securely.
- `/reset` never deletes immediately. It sends a backup and scope preview, then uses an expiring, one-time, two-step owner confirmation and sends a fresh backup before the final deletion. It deletes store/business data while retaining settings, audit history, and the used challenge record.

Only legitimate, authorized digital goods should be loaded into inventory. Inventory values are stored in plaintext so they can be delivered and exported; restrict database and backup access accordingly. Keep regular PostgreSQL backups as well as Iris exports.

## Checks and tests

```sh
npm run db:generate
npm test
npm run lint
npm run typecheck
npm run build
npm audit
```

`npm run db:generate` creates the ignored, schema-specific Prisma Client needed by tests and runtime; run it after a fresh install before `npm test`. The tests apply the committed initial migration to an in-memory PGlite PostgreSQL-compatible database and exercise atomic purchases, concurrent stock allocation, balance and bonus limits, redeem-code uniqueness, exports, reset confirmations, broadcast accounting, and HTML escaping. The integration tests do not contact Telegram or require production credentials.

`npm run typecheck` and `npm run build` generate Prisma Client first. Prisma 7's CLI downloads its schema/query engines from `https://binaries.prisma.sh`; if that host is blocked, generation, CLI validation, migration deployment, and those two scripts cannot complete. The PGlite tests apply the initial SQL migration and exercise the generated client, but they do not replace validating/deploying against a real PostgreSQL server. Restore access to Prisma's binary host, then rerun `npm run db:generate`, `npx prisma validate`, and the production database migration checks.

## Operational notes

- The bot uses grammY's default in-memory sessions. An interrupted owner form is lost on restart; balances, settings, purchases, inventory, and all other persistent data remain in PostgreSQL.
- Callback throttling and broadcast execution are process-local. Run one bot process per bot token unless a shared session/rate-limit strategy is added.
- The initial migration is under `prisma/migrations/20260930000000_init/`. Use `npm run db:deploy` for production deployments; do not edit an already-applied migration in place.
