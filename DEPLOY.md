# Deploying to production

Run these in order. Do not skip ahead: step 6 is the first time a real bank is touched.

**Ground rules**

- Production is the Neon **default branch**. Dev is the Neon **`dev` branch**. Their endpoints differ; always check the host the tool prints before you let it write.
- The production database URL is never put in `.env`. It lives in Vercel, and for the two commands that need it on your machine (steps 2 and 3) it lives in a one-off shell variable.
- Use `prisma migrate deploy` against production. Never `migrate dev`, `migrate reset` or `db push`.
- Use Node 22 locally (`.nvmrc`; the project pins `22.x`).

---

## 0. Before you start

| You need | Why |
|---|---|
| A **Resend** API key and a **verified sender domain** for `EMAIL_FROM` | The magic-link login is the only way into production. There is no login bypass there (see below). |
| **Plaid** production credentials (client id + the **production** secret; it differs from the sandbox secret) | Real bank connection |
| The **Plaid redirect URI registered** (step 1b) | Banks that use OAuth (many large US banks) send the user to the bank's own site and back. Plaid refuses to create the link token until the return address is registered. |
| Your Clover API token and merchant id (same ones as dev) | Revenue sync |

`DEV_AUTH_BYPASS` is inert on Vercel: it is ignored when `NODE_ENV=production` and when `VERCEL_ENV` is `production` or `preview`. Do not set it there anyway; `preflight` warns if you do.

---

## 1. Set the Vercel environment

Vercel → Project → Settings → Environment Variables → **Production**.

| Variable | Value / how to get it |
|---|---|
| `DATABASE_URL` | **Production** Neon branch, **pooled** connection string (host contains `-pooler`) |
| `ENCRYPTION_KEY` | A **new** key for production: `openssl rand -base64 32`. Save it in your password manager. If it is lost, the stored bank token is unrecoverable and the bank must be connected again. Never reuse the dev key. |
| `AUTH_SECRET` | `openssl rand -base64 48` (32+ characters) |
| `CRON_SECRET` | `openssl rand -base64 32` (16+ characters). Also guards `/api/preflight`. |
| `ADMIN_USER_EMAILS` | Comma-separated allowlist (you and the owner) |
| `APP_URL` | The public **https** URL, no trailing slash, e.g. `https://yummy.example.com`. Sign-in links are built from it. |
| `PLAID_CLIENT_ID` | Plaid Dashboard → Developers → Keys |
| `PLAID_SECRET` | The **production** secret |
| `PLAID_ENV` | `production` |
| `PLAID_REDIRECT_URI` | `https://YOUR-APP/plaid/oauth`: **exactly** `APP_URL` + `/plaid/oauth`, and registered in the Plaid Dashboard (step 1b). Required in production. |
| `ALLOW_PLAID_PRODUCTION` | `true`. Without exactly `true`, every Plaid call is refused. This is the guard that protects the Trial plan's 10 non-recyclable Items. |
| `CLOVER_API_BASE` | `https://api.clover.com` |
| `CLOVER_MERCHANT_ID` | Merchant id |
| `CLOVER_API_TOKEN` | Private API token |
| `RESEND_API_KEY` | From Resend |
| `EMAIL_FROM` | e.g. `Yummy Finance <reports@yourdomain.com>` (domain verified in Resend) |
| `BUSINESS_TIMEZONE` | `America/Denver` (must equal Clover's `properties.timezone` and the Business row; preflight checks all three) |

### 1b. Register the OAuth return address with Plaid

Plaid only issues a link token for a redirect URI that is registered, so do this **before** the preflight:

1. Plaid Dashboard → **Developers → API → Allowed redirect URIs → Configure**.
2. Add `https://YOUR-APP/plaid/oauth` (https is required in production; it must match `PLAID_REDIRECT_URI` character for character).
3. For local sandbox testing you may also add `http://localhost:3000/plaid/oauth` (Plaid allows http://localhost in the sandbox only) and set it as `PLAID_REDIRECT_URI` in your dev `.env`.

The preflight proves the registration: it asks Plaid for a link token with the URI and fails with "not registered" if Plaid refuses.

**Do not set on Vercel:** `DIRECT_URL`, `OWNER_EMAIL`, `BUSINESS_NAME`, `CC_EMAIL` (migration/seed inputs that stay on your machine), `DEV_AUTH_BYPASS`.

**Preview deployments:** the simplest safe choice is to set no variables for Preview. Previews then build but cannot do anything. If you want working previews, point them at the dev branch and Plaid **sandbox** (sandbox secret, a separate `ENCRYPTION_KEY`). Never give Preview the production database or production Plaid secret.

Project settings: Node.js version **22.x** (also enforced by `engines` in `package.json`).

---

## 2. Migrate the production database

From your machine, in the repo, with Node 22. The production **direct** (non-pooled) URL goes in a one-off variable; `read -rs` does not echo it or write it to shell history.

```bash
read -rs PROD_DIRECT_URL        # paste the PRODUCTION direct URL, press Enter

DIRECT_URL="$PROD_DIRECT_URL" npx prisma migrate status
```

Read the `Datasource "db"` line: the host must be the **production** endpoint, **not** the dev one (dev is `ep-shy-wave-…`). If it is wrong, stop.
The shell variable overrides `.env`, so your dev URL is not used.

Expected: some migrations already applied (the first three went to this branch early on), the rest pending. Then:

```bash
DIRECT_URL="$PROD_DIRECT_URL" npx prisma migrate deploy
DIRECT_URL="$PROD_DIRECT_URL" npx prisma migrate status    # "Database schema is up to date!"
```

## 3. Seed production

Seeding creates the one Business row and the P&L categories. It is idempotent, and it refuses to run if the existing Business has a different timezone.

```bash
DIRECT_URL="$PROD_DIRECT_URL" \
BUSINESS_TIMEZONE="America/Denver" \
OWNER_EMAIL="owner@example.com" \
CC_EMAIL="you@example.com" \
BUSINESS_NAME="La Michoacana Yummy!" \
npx prisma db seed

unset PROD_DIRECT_URL
```

Expected output: `Created business …` and `Categories ensured: 31`.

## 4. Deploy

Push to the branch Vercel deploys, or `vercel --prod`. The build runs `prisma generate` (needs no database) and `next build`. If the build fails, read the log; nothing has touched your bank yet.

## 5. Run the preflight against production

The preflight runs **inside** Vercel's production environment, so production secrets never leave Vercel:

```bash
read -rs CRON_SECRET            # paste the production CRON_SECRET
curl -s -H "Authorization: Bearer $CRON_SECRET" https://YOUR-APP/api/preflight | jq
unset CRON_SECRET
```

You want `"ok": true` and no `FAIL`. It checks, by name and outcome only (never values): required variables, secret lengths, `APP_URL` is public https, Plaid production guard, `DEV_AUTH_BYPASS` off, Node version, `ENCRYPTION_KEY` decodes to 32 bytes, database reachable, one Business row, no pending migrations, stored bank tokens decryptable, Clover token reaches `/merchants/{mId}` and its timezone matches `BUSINESS_TIMEZONE`, the Plaid client builds for `production`, `PLAID_REDIRECT_URI` equals `APP_URL` + `/plaid/oauth` **and is registered with Plaid**, and the Resend key (and sender domain) is valid.

Fix every `FAIL` before going on. A **"redirect URI registered"** failure means step 1b is not done. A `WARN` is worth reading.

(`npm run preflight` runs the same checks on your machine against whatever `.env` is loaded; use it on dev.)

## 6. Log in

Open `https://YOUR-APP/login`, enter an address from `ADMIN_USER_EMAILS`, open the emailed link (valid 15 minutes, single use), click **Sign in**. There is no bypass on Vercel; if the email does not arrive, fix Resend (`preflight` tells you why).

## 7. Connect the bank (this uses a real, non-recyclable Plaid Item)

On `/admin/connections` the page should say **Plaid environment: production**. Then:

1. Click **Connect your bank** and complete Plaid Link with the owner's real credentials.
2. Confirm the institution, accounts and status **Connected** appear.
3. Depository and credit accounts are marked **synced** by default; loans and investments are not. Adjust with the buttons.

Only one Item per environment can exist (the app refuses a second). If connecting fails partway, the app removes the new Item at Plaid, so a slot is not silently lost.

> **OAuth banks.** If the owner's bank uses OAuth, Link sends him to the bank's own site to sign in, then back to `/plaid/oauth`, which re-opens Link, saves the connection and returns to Connections. This needs step 1b. Notes:
> - Keep the same browser tab through the whole flow (the in-progress connection is kept in that tab's session storage). If he opens the return link in a different browser, the page says so and asks him to start again; nothing is saved or lost.
> - Plaid's docs disagree on whether the free **Trial** plan reaches OAuth banks without full Production approval. If the bank does not appear in Link, check your plan in the Plaid Dashboard before assuming a bug.
> - The browser leg of this flow has only been tested up to the server side. Do a first run with the owner present.

## 8. First sync

Click **Sync now** on `/admin/connections` and keep the page open. It runs the Plaid transaction sync, then Clover for the current month plus the two before it, and prints the counts.

- First run: up to 730 days of bank history. It can take several minutes (limit 300 s). If it times out, run it again; it is idempotent and picks up where it left off.
- "Plaid is still preparing transactions" is normal for a brand-new Item. Wait a minute and run again.
- A second run should report almost no changes.

---

## Resetting the Neon dev branch from prod

Do this after prod has real data, to test against a realistic copy.

1. Neon console → the **dev** branch → **Reset from parent**. The connection strings normally stay the same; confirm `npm run preflight` still prints the dev host.
2. Dev now contains **real production data**: the real Plaid Item row, real bank transactions, real Clover payments.
3. Keep dev isolated from production secrets. Never copy prod's `ENCRYPTION_KEY`, `PLAID_SECRET` or `ALLOW_PLAID_PRODUCTION` into dev `.env`. Dev stays `PLAID_ENV=sandbox`.
4. What dev will do with the copied bank connection is handled, not an error: the Item belongs to the `production` environment and is encrypted with prod's key, so dev ignores it. `/admin/connections` says "Ignored here: … (production)", and `npm run sync:plaid` says it cannot use it. Connect a sandbox bank (`npm run plaid:sandbox-connect`) next to it.
5. Apply any migrations written after the last prod deploy to dev with `npx prisma migrate dev`.
6. If you do not want real transactions on a dev machine, wipe them on **dev only** (check the host first):
   ```sql
   DELETE FROM "BankTransaction"; DELETE FROM "BankAccount"; DELETE FROM "PlaidItem" WHERE environment = 'production';
   ```
   (Locked month snapshots cannot be deleted by design; a reset from parent is the only way to clear them.)

---

## If something goes wrong

| Symptom | Likely cause |
|---|---|
| `preflight` `FAIL migrations` | Step 2 not run or run against the wrong database |
| `preflight` `FAIL clover: timezone` | `BUSINESS_TIMEZONE` or the Business row is not the Clover timezone |
| Link never opens / immediate Plaid error | Wrong Plaid secret for the environment, or `ALLOW_PLAID_PRODUCTION` is not exactly `true` |
| "The bank return address isn't registered with Plaid yet" | Step 1b: register `PLAID_REDIRECT_URI` in the Plaid Dashboard |
| Bank redirects back and the page says "can't be finished here" | The connection was started in another tab/browser, or session storage was cleared. Start again from Connections. |
| "stored bank token cannot be decrypted" | `ENCRYPTION_KEY` differs from the one that encrypted it |
| Status `LOGIN_REQUIRED` | Normal after a bank password change or expiry: use **Reconnect bank** |
| Sync says "already running" | Another sync is in progress; a crashed run frees itself after 10 minutes |
