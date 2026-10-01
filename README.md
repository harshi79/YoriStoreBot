# Iris — Telegram Credit Store Bot

Iris is a Node.js 22 / TypeScript Telegram bot for an owner-managed digital-goods store. It uses grammY, PostgreSQL, Prisma 7, and environment-based configuration. Store categories, products, inventory, redeem codes, balances, and the credit ledger are database-backed.

## Iris Mini App

A mobile-first React/TypeScript storefront is included under `web/`. The bot and the Mini App share the **same Prisma database and services**, not separate balances or browser-only order data.

- Browse/search categories and live stock; sort the collection and inspect delivery/replacement rules.
- Purchase 1–10 items with the same atomic, idempotent checkout as the bot. A pending checkout key is kept across page reloads so a lost response can be retried safely.
- Open private, grouped orders; reveal delivery codes, copy them, download complete batch receipts, and submit per-item replacement claims.
- View a live wallet/ledger, redeem codes, claim daily bonuses, and see referral rewards.
- Save a database-backed wishlist, view your Telegram-linked profile, and switch appearance locally.
- Production login verifies Telegram `initData` with HMAC, rejects expired/forged data, and issues short-lived signed sessions. No `initDataUnsafe` identity, bot token, database credentials or unsold stock values are sent to the browser.

### Try the isolated preview

```sh
npm ci
npm run db:generate
npm run mini:build
npm run mini:demo
```

Open `http://localhost:3001` (or the live preview exposed by your host). `MINI_API_PORT`/`PORT` can override the preview port. The preview is explicitly labelled **demo**: its synthetic profile, credits, codes and stock are stored in `.pglite/mini-app-demo`, separate from the bot’s `.pglite/iris` development store and from PostgreSQL. It ignores the real bot token/database URL and refuses to run with `NODE_ENV=production`. Demo codes do not activate real products. Changes persist in that isolated preview database. No production seed/reset endpoint exists.

For frontend hot reload, keep the preview API running with `MINI_API_PORT=3001 npm run mini:demo` and run `npm run mini:dev` in a second terminal. Vite proxies relative `/api` requests to it; browsers never connect to a backend on their own localhost.

Optional browser journey checks (demo only; start the preview first):

```sh
npx playwright install chromium
npm run test:e2e
```

Set `MINI_APP_TEST_URL` if the preview uses a port other than 3001. The browser test refuses a non-demo API and checks category/search, persisted wishlist changes, wallet/profile navigation, bulk checkout, private receipt download, dark mode and mobile layout. It consumes synthetic demo stock/credits; it never touches real goods.

### Connect the live Telegram Mini App

1. Configure a real `BOT_TOKEN`, the same PostgreSQL `DATABASE_URL` as your bot, `NODE_ENV=production`, `PORT`, and `MINI_APP_URL=https://YOUR_PUBLIC_DOMAIN` on the host. Never place secrets in a `VITE_*` variable.
2. Back up/stop the old bot. Apply **all** migrations (including `20261002010000_mini_app_wishlist`), build and start:

   ```sh
   npm run db:deploy
   npm run build
   npm start
   ```

   `build` is now a normal one-shot command that generates Prisma Client, typechecks both projects, compiles the bot, and builds the Mini App. Use **`npm start`**, not `npm run build`, as the host’s Start Command.
3. Expose the Node `PORT` over HTTPS. It serves the built frontend, API and `/health` readiness endpoint. Telegram clients and Arena previews may embed it; no iframe-denying header is set.
4. In @BotFather, configure your bot’s Main Mini App to that public HTTPS URL. Restart the bot: it registers an **Open Iris** Telegram menu button and adds `/app` plus an inline Mini App button to `/start`.
5. Open the app from that bot to supply valid Telegram-signed login data. A normal production browser does not get a fake account or demo login.

If you host the web API separately, run `npm run mini:serve` after `npm run build` with the same token/database URL. That process verifies the bot with `getMe` but does **not** start a second long-polling instance. Use PostgreSQL to share data across processes; embedded PGlite is a single-process development store.

Credit top-ups remain owner-managed/code-based; this release does not take real payments or add a payment gateway. Catalog product photos currently use the app’s branded artwork; product data, prices and availability are always read from the database. Owner management remains in the authorized Telegram `/admin` panel.

## Quick start

1. Install Node.js 22 and PostgreSQL, then install dependencies:

   ```sh
   npm ci
   ```

2. Copy `.env.example` to `.env` and edit it locally. Set the BotFather token and a PostgreSQL `DATABASE_URL`; for deployment, set `NODE_ENV=production`. Keep `.env` out of version control. Do not send the bot token in chat or commit it.

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

   `npm run dev` runs the TypeScript entry point in watch mode. Iris verifies its database connection and Telegram credentials at startup, configures command menus, and gracefully closes polling and PostgreSQL on shutdown signals. The Telegram menu shows public commands plus `/admin`; other owner commands are intentionally not advertised, and `/admin` remains owner-authorized server-side.

The sole authorized owner is fixed at Telegram ID `7728424218`; all owner commands, owner callbacks, and active owner form submissions are checked against that ID server-side, in addition to being restricted to private chats.

## Environment variables

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `BOT_TOKEN` | Yes | — | Telegram Bot API token from BotFather |
| `DATABASE_URL` | Yes in production | — | PostgreSQL connection URL; also selects PostgreSQL in development/test |
| `NODE_ENV` | No | `production` | `production` requires PostgreSQL; `development` permits disk-backed local PGlite; only `test` permits in-memory PGlite |
| `LOG_LEVEL` | No | `info` | Pino log level |
| `BONUS_CREDITS` | No | `25` | Default daily bonus amount |
| `BONUS_PERIOD_HOURS` | No | `24` | Default bonus cooldown, 1–720 hours |
| `DATABASE_POOL_SIZE` | No | `10` | PostgreSQL connection pool size |
| `PM2_APP_NAME` | No | empty | Exact PM2 app name for the optional `/restart` command |
| `MINI_APP_URL` | For the live Mini App | empty | Public HTTPS address used by `/app`, `/start`, and the Telegram menu button |
| `PORT` | For web hosting | `3000` when `MINI_APP_URL` is set | Node frontend/API/health listener |

The bonus settings can also be changed from the owner panel; those overrides are stored in PostgreSQL. `/restart` only runs when `PM2_HOME` is present and Iris can verify the configured PM2 process. Otherwise, it explains that the host must restart the bot.

## Storage safety and deployment

- **Production (the default):** set a real PostgreSQL `DATABASE_URL`; use `NODE_ENV=production` explicitly on your host as well. Missing, blank, or example-placeholder URLs are rejected. Connection errors, required-SSL failures, and missing purchase-schema migrations stop startup. The bot never switches a configured PostgreSQL store to embedded storage or silently disables SSL.
- **Development:** explicitly set `NODE_ENV=development`; omitting `DATABASE_URL` then initializes a disk-backed PGlite store under `.pglite/iris`. A filesystem/database initialization error stops startup instead of falling back to memory. If a PostgreSQL URL is supplied, connection errors remain errors even for localhost.
- **Tests:** explicitly selecting `NODE_ENV=test` permits in-memory PGlite. Both configuration loading and the database factory default to production safety when no environment is passed.
- **Health checks:** the HTTP listener, when `PORT` is supplied, returns `503` until database/schema checks and Telegram setup finish and polling starts. It returns `503` again while polling is stopped/retrying or the bot is shutting down. Invalid configuration exits before opening the listener.

Production startup only checks schema readiness; it does not create or upgrade tables. Back up the database and stop the previous bot process, then apply the committed migrations **before** starting the new build:

```sh
npm run db:deploy
npm run build
npm start
```

The purchase-batch migration (`20261002000000_purchase_batches`) preserves existing purchases, stock, balances, and ledger entries, and backfills safely matched legacy bulk deliveries. New bulk items have a persistent batch ID and item index, so retry reconstruction does not depend on the requested quantity or a process-local session.

If an older deployment created PostgreSQL tables automatically without Prisma migration history, back up the database and verify its schema matches the initial migration before baselining it with `npx prisma migrate resolve --applied 20260930000000_init`. Then run `npm run db:deploy` to actually apply the purchase-batch migration. Do not mark the new migration applied without running it.

## User features

- `/start` sends Iris's welcome video (`https://imglink.cc/cdn/jw1NZXEQQS.mp4`) with a text fallback and inline navigation.
- `/start`, `/app`, `/store`, `/search QUERY`, `/profile`, `/wallet`, `/bonus`, `/redeem CODE`, `/orders`, `/help`, and `/cancel` are available in private chats; `/admin` appears in the menu but is owner-only. `/wallet` shows the current balance and a private, paginated credit ledger with each change and the resulting balance.
- Categories and products come from PostgreSQL; products show current stock and credit prices. Interactive screens use Telegram Bot API 10.3 rich messages: compact item/order tables, styled in-message buttons, and expandable delivery notes. If a rich message cannot be sent or edited, Iris falls back to HTML and inline keyboards.
- `/orders` keeps a private, paginated purchase history. Opening an order shows parsed email/login, password, plan fields, and delivery rules; users can also download a `.txt` receipt. Order history and delivery screens use Rich Message tables with an HTML fallback.
- Daily bonuses and code redemptions use conditional database updates and write matching credit-ledger rows in the same transaction.
- Purchases lock available stock, charge the buyer, mark inventory sold, write the purchase and ledger record atomically, and use a PostgreSQL transaction-level request lock plus an idempotency key to make concurrent callback retries safe. Bulk retries return every original item in order and the original total price without allocating stock or charging again. Delivery is returned only to the purchasing Telegram account. Purchase history and warranty claims remain per item.
- All sales are final; refunds are not offered. Eligible delivery issues can be reviewed for replacement from available stock during the product's stated replacement window.

## Owner features

Open `/admin` for a sectioned owner console with management for categories, products, inventory, users, redeem codes, purchases, credit settings, statistics, exports, broadcast, restart, and reset. Additional owner-only commands are `/gift USER_ID CREDITS`, `/rm USER_ID CREDITS`, `/giftall CREDITS`, `/code AMOUNT CREDITS MAXREDEEMS`, `/broadcast`, `/stats`, `/export`, `/addstock`, `/restart`, and `/reset`; they remain usable when typed but are not listed in the Telegram command menu. Delivery-issue claims may be replaced from available stock or rejected; the owner panel has no refund action.

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

`npm run db:generate` creates the ignored, schema-specific Prisma Client needed by tests and runtime; run it after a fresh install before `npm test`. The tests apply the committed migrations to an in-memory PGlite PostgreSQL-compatible database and exercise atomic purchases, concurrent stock allocation, complete bulk replay (including long request keys and reusable/free goods), production storage failures, health readiness, legacy batch backfills, balance and bonus limits, redeem-code uniqueness, exports, reset confirmations, broadcast accounting, and HTML escaping. The integration tests do not contact Telegram or require production credentials. Mini App tests additionally exercise signature/session validation, forged identities, API authorization, secret-free catalog serialization, scoped wishlists, grouped private deliveries/receipts, code/bonus limits and credit immutability. Frontend TypeScript checks are included in `typecheck` and `build`.

To also run the service/callback suite against a real PostgreSQL server, supply a **dedicated test database** connection with permission to create schemas:

```sh
TEST_POSTGRES_URL=postgresql://TEST_USER:TEST_PASSWORD@localhost:5432/iris_test npm test
```

That suite creates and drops a unique `iris_test_*` schema; it does not use the application's `DATABASE_URL` or delete existing tables. The embedded-storage and legacy-migration tests still use isolated PGlite databases. Never point test tooling at a production database.

`npm run typecheck` and `npm run build` generate Prisma Client first. The client-generation helper avoids a native-engine download for generation, but this does not deploy or validate database migrations. Prisma's migration CLI still requires its native schema engine, downloaded from `https://binaries.prisma.sh` when missing. If that host is blocked, `db:deploy`/`db:migrate` cannot complete; do not skip migrations or start production with an old schema. Restore access to Prisma's binary host, then rerun `npx prisma validate` and the production database migration checks. The PGlite and optional PostgreSQL tests apply SQL migrations in isolated test databases; they do not replace deploying migrations to the production database.

## Operational notes

- The bot uses grammY's default in-memory sessions. An interrupted owner form is lost on restart; balances, settings, purchases, inventory, and all other persistent data remain in PostgreSQL.
- Callback throttling and broadcast execution are process-local. Run one bot process per bot token unless a shared session/rate-limit strategy is added.
- The initial migration is under `prisma/migrations/20260930000000_init/`; purchase grouping is added by `prisma/migrations/20261002000000_purchase_batches/`. Use `npm run db:deploy` before starting production builds; do not edit an already-applied migration in place.
