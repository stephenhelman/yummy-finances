# Deploying to production

Run these in order. Do not skip ahead: step 6 is the first time a real bank is touched.

**Ground rules**

- Production is the Neon **default branch**. Dev is the Neon **`dev` branch**. Their endpoints differ; always check the host the tool prints before you let it write.
- The production database URL is never put in `.env`. It lives in Vercel, and for the two commands that need it on your machine (steps 2 and 3) it lives in a one-off shell variable.
- Migrate production only with `npm run db:deploy -- --target prod` (it checks the Neon endpoint against `YUMMY_PROD_ENDPOINT` first and wraps `prisma migrate deploy`). Never `migrate dev`, `migrate reset` or `db push`.
- Use Node 22 locally (`.nvmrc`; the project pins `22.x`).

---

## 0. Before you start

| You need | Why |
|---|---|
| The **Apps Script mailer deployed** (step 0b): its web app URL and shared secret | Emailed magic links are the way into production, and the monthly report is sent through it. `preflight` **fails in production** if it is missing or doesn't answer a ping. `DEV_AUTH_BYPASS` is inert on Vercel (see below). |
| A **Vercel project** (no custom domain needed) | The app lives at its `https://<project>.vercel.app` address. Use that address wherever the steps below say `<project>.vercel.app`. |
| **Plaid** production credentials (client id + the **production** secret; it differs from the sandbox secret) | Real bank connection |
| The **Plaid redirect URI registered** (step 1b) | Banks that use OAuth (many large US banks) send the user to the bank's own site and back. Plaid refuses to create the link token until the return address is registered. |
| Your Clover API token and merchant id (same ones as dev) | Revenue sync |

`DEV_AUTH_BYPASS` is inert on Vercel: it is ignored when `NODE_ENV=production` and when `VERCEL_ENV` is `production` or `preview`. Do not set it there anyway; `preflight` warns if you do.

### 0b. Deploy the Apps Script mailer (on Stephen's Google account)

Follow [`apps-script/README.md`](apps-script/README.md): paste `Code.gs` and `appsscript.json` into a new Apps Script project, set the `APPS_SCRIPT_SECRET` (and optional `DRIVE_FOLDER_ID`) script properties, authorize once, and deploy as a Web app (**Execute as: Me**, **Who has access: Anyone**). Keep the `/exec` URL and the secret for step 1. The script, the report workbooks and the Drive folder (`DRIVE_FOLDER_ID`) all live on **Stephen's** Google account, with the folder **shared with the owner** so they can open the reports. It can be moved to the shop's account later by redeploying it there and updating `APPS_SCRIPT_URL`/`APPS_SCRIPT_SECRET`. Sign-in emails and monthly reports are sent from Stephen's Google account (about 100 emails/day on a free Gmail account).

---

## 1. Set the Vercel environment

Vercel → Project → Settings → Environment Variables → **Production**.

| Variable | Value / how to get it |
|---|---|
| `DATABASE_URL` | **Production** Neon branch, **pooled** connection string (host contains `-pooler`) |
| `ENCRYPTION_KEY` | A **new** key for production: `openssl rand -base64 32`. Save it in your password manager. If it is lost, the stored bank token is unrecoverable and the bank must be connected again. Never reuse the dev key. To replace a key later, follow [Key rotation](#key-rotation). |
| `ENCRYPTION_KEY_PREVIOUS` | **Leave unset.** Set only for the duration of a [key rotation](#key-rotation): the OLD key, so existing tokens stay readable until they are re-encrypted. `preflight` warns while it is set. |
| `AUTH_SECRET` | `openssl rand -base64 48` (32+ characters) |
| `CRON_SECRET` | `openssl rand -base64 32` (16+ characters). Also guards `/api/preflight`. |
| `ADMIN_USER_EMAILS` | Comma-separated allowlist (you and the owner) |
| `APP_URL` | The public **https** URL, no trailing slash, e.g. `https://yummy-finances.vercel.app` (the project's `*.vercel.app` address; use the **production** domain, not a per-deployment preview URL). Sign-in links are built from it. |
| `PLAID_CLIENT_ID` | Plaid Dashboard → Developers → Keys |
| `PLAID_SECRET` | The **production** secret |
| `PLAID_ENV` | `production` |
| `PLAID_REDIRECT_URI` | `https://<project>.vercel.app/plaid/oauth`: **exactly** `APP_URL` + `/plaid/oauth`, and registered in the Plaid Dashboard (step 1b). Required in production. |
| `ALLOW_PLAID_PRODUCTION` | `true`. Without exactly `true`, every Plaid call is refused. This is the guard that protects the Trial plan's 10 non-recyclable Items. |
| `CLOVER_API_BASE` | `https://api.clover.com` |
| `CLOVER_MERCHANT_ID` | Merchant id |
| `CLOVER_API_TOKEN` | Private API token |
| `APPS_SCRIPT_URL` | The Apps Script web app URL (ends in `/exec`), from step 0b. **Required in production.** |
| `APPS_SCRIPT_SECRET` | The same shared secret you set as a script property in step 0b (at least 16 characters). **Required in production.** |
| `LOGIN_PASSCODE` | **Leave unset.** It is an emergency fallback only (see [Emergency access](#emergency-access)); unset means the passcode form and `/api/auth/passcode` are disabled (404). |
| `BUSINESS_TIMEZONE` | `America/Denver` (must equal Clover's `properties.timezone` and the Business row; preflight checks all three) |

### 1b. Register the OAuth return address with Plaid

Plaid only issues a link token for a redirect URI that is registered, so do this **before** the preflight:

1. Plaid Dashboard → **Developers → API → Allowed redirect URIs → Configure**.
2. Add `https://<project>.vercel.app/plaid/oauth` (https is required in production; it must match `PLAID_REDIRECT_URI` character for character).
3. For local sandbox testing you may also add `http://localhost:3000/plaid/oauth` (Plaid allows http://localhost in the sandbox only) and set it as `PLAID_REDIRECT_URI` in your dev `.env`.

The preflight proves the registration: it asks Plaid for a link token with the URI and fails with "not registered" if Plaid refuses.

**Do not set on Vercel:** `DIRECT_URL`, `OWNER_EMAIL`, `BUSINESS_NAME`, `CC_EMAIL` (migration/seed inputs that stay on your machine), `DEV_AUTH_BYPASS`.

**Preview deployments:** the simplest safe choice is to set no variables for Preview. Previews then build but cannot do anything. If you want working previews, point them at the dev branch and Plaid **sandbox** (sandbox secret, a separate `ENCRYPTION_KEY`). Never give Preview the production database or production Plaid secret.

Project settings: Node.js version **22.x** (also enforced by `engines` in `package.json`).

---

## 2. Migrate the production database

From your machine, in the repo, with Node 22. The production **direct** (non-pooled) URL goes in a one-off variable; `read -rs` does not echo it or write it to shell history.

**Never run `prisma migrate deploy` directly.** Use the guarded wrapper. It prints the Neon endpoint first and refuses unless `DIRECT_URL`'s endpoint ID equals `YUMMY_PROD_ENDPOINT` (or `YUMMY_DEV_ENDPOINT` for `--target dev`). Set both in your local `.env` once (the `ep-xxxx-xxxx-xxxxxxxx` part of each host, no `-pooler`; never on Vercel). This exists because Yummy migrations were once applied to another project's database.

```bash
read -rs PROD_DIRECT_URL        # paste the PRODUCTION direct URL, press Enter

DIRECT_URL="$PROD_DIRECT_URL" DATABASE_URL="$PROD_DIRECT_URL" npm run db:status -- --target prod
```

Read the `Endpoint:` line it prints and confirm it is the **production** endpoint for **this** app (not dev, `ep-shy-wave-…`, and not any other project). If it says `REFUSED`, stop; nothing ran.
The shell variables override `.env`, so your dev URL is not used. `DATABASE_URL` is set too because the guard also refuses when it points at a different endpoint than `DIRECT_URL` (the migration itself only uses `DIRECT_URL`).

Expected: some migrations already applied (the first three went to this branch early on), the rest pending. Then:

```bash
DIRECT_URL="$PROD_DIRECT_URL" DATABASE_URL="$PROD_DIRECT_URL" npm run db:deploy -- --target prod
DIRECT_URL="$PROD_DIRECT_URL" DATABASE_URL="$PROD_DIRECT_URL" npm run db:status -- --target prod    # "Database schema is up to date!"
```

`npm run predeploy -- --target prod` runs the check alone.

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

Expected output: `Created business …`, `Categories ensured: 32` and `Rules: 57 created, 0 updated, 0 unchanged (57 defined)`. On a database that already has the old category name it also prints `Renamed category "Ingredients and dairy" to "Dairy & ingredients"`.

> You do **not** need to run the seed on production for the rules: the [Rules release](#rules-release) (the `apply-rules` call) applies the category changes, stores the rules and categorizes existing transactions from inside Vercel, so production credentials stay there. The seed's rule step is for dev.

## 4. Deploy

Push to the branch Vercel deploys, or `vercel --prod`. The build runs `prisma generate` (needs no database) and `next build`. If the build fails, read the log; nothing has touched your bank yet.

## 5. Run the preflight against production

The preflight runs **inside** Vercel's production environment, so production secrets never leave Vercel:

```bash
read -rs CRON_SECRET            # paste the production CRON_SECRET
curl -s -H "Authorization: Bearer $CRON_SECRET" https://<project>.vercel.app/api/preflight | jq
unset CRON_SECRET
```

You want `"ok": true` and no `FAIL`. It checks, by name and outcome only (never values): required variables, secret lengths, `APP_URL` is public https, Plaid production guard, `DEV_AUTH_BYPASS` off, Node version, `ENCRYPTION_KEY` decodes to 32 bytes, database reachable, one Business row, no pending migrations, every stored bank token for this Plaid environment decrypts with the **current** key (a **fail** otherwise; a **warn** while `ENCRYPTION_KEY_PREVIOUS` is set or tokens still use it), Clover token reaches `/merchants/{mId}` and its timezone matches `BUSINESS_TIMEZONE`, the Plaid client builds for `production`, `PLAID_REDIRECT_URI` equals `APP_URL` + `/plaid/oauth` **and is registered with Plaid**, and the Apps Script mailer (when configured) answers a `ping` with the shared secret, and at least one login method is configured. In production it **fails** if the mailer variables are missing or the ping fails, and **warns** if `LOGIN_PASSCODE` is set.

Fix every `FAIL` before going on. A **"redirect URI registered"** failure means step 1b is not done. A `WARN` is worth reading.

(`npm run preflight` runs the same checks on your machine against whatever `.env` is loaded; use it on dev.)

## 6. Log in

Open `https://<project>.vercel.app/login`, enter an address from `ADMIN_USER_EMAILS`, open the emailed link (valid 15 minutes, single use), click **Sign in**. There is no bypass on Vercel; if the email does not arrive, fix the Apps Script mailer (`preflight` tells you why; remember a script edit only goes live after **Manage deployments → New version**).

The emailed link says to open it in your phone's **main browser** (Safari on iPhone, Chrome on Android), not inside the Mail/Gmail app, so the session cookie stays where you will use the app. A session lasts 14 days.

### Emergency access

Use this only if the mailer is broken and you cannot get a login email (for example the Apps Script authorization lapsed or its quota ran out).

1. In Vercel, set `LOGIN_PASSCODE` to a passphrase of **at least 20 characters** and redeploy.
2. Open `https://<project>.vercel.app/login`, enter it under **Passcode**, tap **Sign in with passcode**. Five wrong tries from one IP lock that IP out for 15 minutes. The audit log records every attempt (IP only, never the passcode) and the session as `passcode`.
3. When the mailer is fixed, **remove `LOGIN_PASSCODE` from Vercel and redeploy**. The passcode form and route turn off again and any passcode sessions stop working. (`preflight` warns while it is set in production.)

Changing the passcode does not sign out an existing passcode session; to force everyone out, change `AUTH_SECRET`.

## 7. Connect the bank (this uses a real, non-recyclable Plaid Item)

On `/admin/connections` the page should say **Plaid environment: production**. Then:

1. Click **Connect your bank** and complete Plaid Link with the owner's real credentials.
2. Confirm the institution, accounts and status **Connected** appear.
3. Depository and credit accounts are marked **synced** by default; loans and investments are not. Adjust with the buttons.

Several banks can be connected (**Add another bank**), but only one Item per bank per environment: connecting a bank that is already connected is refused and the new Item is removed at Plaid. Each Item uses one of the Trial plan's 10 non-recyclable slots, so add banks deliberately. Only one connection can be in progress at a time. If connecting fails partway, the app removes the new Item at Plaid, so a slot is not silently lost.

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

## Rules release

Use this whenever the rules or categories change (a new rule, a category rename), including the very first time on a database that has existing transactions. It runs **inside Vercel**, so production credentials never touch your machine. It is idempotent: calling it twice is safe, and the second call changes nothing.

**Order matters:**

1. **Migrate production** (from your machine, as in step 2):
   ```bash
   DIRECT_URL="$PROD_DIRECT_URL" DATABASE_URL="$PROD_DIRECT_URL" npm run db:deploy -- --target prod
   DIRECT_URL="$PROD_DIRECT_URL" DATABASE_URL="$PROD_DIRECT_URL" npm run db:status -- --target prod      # "Database schema is up to date!"
   ```
   Do this **before** pushing: the new code expects the new columns.
2. **Push** (or `vercel --prod`).
3. **Wait for the deployment to be Ready** in Vercel. Calling the route while the old build is still live would run old code.
4. **Call `apply-rules`:**
   ```bash
   read -rs CRON_SECRET            # paste the production CRON_SECRET
   curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" https://<project>.vercel.app/api/admin/apply-rules | jq
   unset CRON_SECRET
   ```
   It takes up to a few minutes on the first run (the limit is 300 s). If it times out, call it again: it picks up where it left off.
5. **Check the summary** in the response (counts only). On the first run expect:
   - `"ok": true`, `"alreadyUpToDate": false`
   - `categories`: `renamed` 1 (the old name becomes "Dairy & ingredients") and `added` 1 ("Candy & toppings")
   - `rules`: `created` 57, `total` 57
   - `applied`: `changed` equal to `considered` (every row is categorized the first time), `skippedLocked` 0 (no month is locked yet), `legacyCleared` equal to the leftover default kinds
   - `summary.autoClassifiedPct` and `pnlClassifiedPct`: the share of outflow dollars sorted automatically. These depend on the real data; large drops from what you saw on dev mean something is off.
6. **Call it a second time**: it must report `"alreadyUpToDate": true` and zero changes.
7. **Run the preflight** (step 5). `rules: classification` should say **PASS** (rules stored, backfill completed). It is a **WARN** until the release has run.

What it does, in order (and stops at the first failure, leaving nothing half-done): applies the planned category changes (a rename keeps the same row, so nothing already linked to it is lost), stores the rules, categorizes every transaction, then writes a "backfill complete" marker. It never un-confirms or re-enables a rule that already exists, never overwrites a transaction a person categorized, and never touches a month that has been locked.

**Until it has run, nothing reads categories.** Transaction categories are marked "pending" until the release has completed: the marker is what `classificationReady` / `requireClassification` check, and a test fails if new code reads transactions without using them.

Rehearse it any time on dev with `npm run rehearse:release`: it resets dev to the "just migrated" state inside a transaction that is always rolled back, runs the release twice, and prints the counts.

If it fails: a message starting with `Category` or `Rule` names the problem (for example a rule that refers to a category that does not exist); anything else is "rules release failed" and the details are in the Vercel function log. A `409 already_running` means another call is in progress (a crashed call frees itself after 15 minutes).

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

## Key rotation

Use this to replace `ENCRYPTION_KEY` (for example because prod and dev ended up sharing one, or the old key may have been exposed). Stored Plaid access tokens are encrypted with that key; rotation re-encrypts them under a new key **without disconnecting the bank**. It runs inside Vercel, so the production keys never touch your laptop.

How it works: while `ENCRYPTION_KEY_PREVIOUS` is set, the app reads a token with the current key and falls back to the previous one, but it always **writes** with the current key. `POST /api/admin/rotate-tokens` then moves every stored token onto the current key (idempotent; it returns counts only and never logs a token).

> **Order matters.** If you change `ENCRYPTION_KEY` *without* also setting `ENCRYPTION_KEY_PREVIOUS`, every stored token becomes unreadable until you put the old key back (`preflight` fails). Nothing is lost by that mistake, because the tokens are not modified, but syncing stops until it is fixed.

1. **Generate the new key** and save it in your password manager: `openssl rand -base64 32`. Keep the old key too, until step 7.
2. **In Vercel (Production)** set `ENCRYPTION_KEY` = the **new** key and `ENCRYPTION_KEY_PREVIOUS` = the **old** key.
3. **Redeploy.** Run the preflight (section 5): expect a **WARN** that rotation is in progress and a WARN that tokens still use the previous key. Any **FAIL** on `encryption:` means a key was pasted wrongly; fix it before going on.
4. **Rotate the tokens:**
   ```bash
   read -rs CRON_SECRET            # paste the production CRON_SECRET
   curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" https://<project>.vercel.app/api/admin/rotate-tokens | jq
   unset CRON_SECRET
   ```
   Expected: `{"ok":true,"previousKeySet":true,"total":N,"rotated":N,"alreadyCurrent":0,"failed":0}`. Running it again is safe and should report `"rotated":0,"alreadyCurrent":N`.
5. **Confirm everything rotated:** `failed` must be `0` and `rotated + alreadyCurrent` must equal `total`. If `failed` is not 0 (HTTP 422), **stop**: a token is unreadable with both keys. Do not remove `ENCRYPTION_KEY_PREVIOUS`; check that you pasted the correct old key, or reconnect that bank from `/admin/connections`.
6. **Delete `ENCRYPTION_KEY_PREVIOUS`** in Vercel and **redeploy**.
7. **Run the preflight again.** The rotation warnings are gone and `encryption: stored bank tokens` says **PASS** (every token decrypts with the current key). From now on a token that cannot be read with the current key is a **FAIL**.
8. **Reset the Neon dev branch from prod** (see the next section). Dev's copies of the tokens are then encrypted with the new key, which dev does not have, so they are unreadable there. Dev keeps its own (old) key and must **not** be given the new one.

To rehearse the mechanics without changing anything: `npm run rehearse:rotation` rotates the tokens in the configured database inside a transaction that is always rolled back, and prints counts. (Run it against dev, never with a production URL on your laptop.)

**Old copies.** The previous ciphertexts still exist in Neon's history and backups, and in any earlier copy of the database, and the old key still reads them. If the old key may have leaked, also rotate the bank access tokens at Plaid itself (Plaid's `/item/access_token/invalidate` issues a new token and kills the old one); this app does not do that for you yet.

---

## If something goes wrong

| Symptom | Likely cause |
|---|---|
| `preflight` `FAIL migrations` | Step 2 not run or run against the wrong database |
| `preflight` `FAIL clover: timezone` | `BUSINESS_TIMEZONE` or the Business row is not the Clover timezone |
| Link never opens / immediate Plaid error | Wrong Plaid secret for the environment, or `ALLOW_PLAID_PRODUCTION` is not exactly `true` |
| "The bank return address isn't registered with Plaid yet" | Step 1b: register `PLAID_REDIRECT_URI` in the Plaid Dashboard |
| Bank redirects back and the page says "can't be finished here" | The connection was started in another tab/browser, or session storage was cleared. Start again from Connections. |
| "stored bank token cannot be decrypted" | `ENCRYPTION_KEY` differs from the one that encrypted it. If you are mid-rotation, set `ENCRYPTION_KEY_PREVIOUS` to the old key. |
| `apply-rules` returns 500 `Category … does not exist` | A rule refers to a category the database lacks: the release creates the planned ones itself; any other missing name means a category was renamed or deleted by hand |
| `preflight` `WARN rules: classification` | The rules release has not run on this database yet: [Rules release](#rules-release) |
| `rotate-tokens` returns 422 / `failed` > 0 | A token is unreadable with both keys: check `ENCRYPTION_KEY_PREVIOUS` is the key that encrypted it, or reconnect that bank |
| `rotate-tokens` returns 500 `ENCRYPTION_KEY…` | A key variable is missing or not 32 bytes (the message names the variable, never its value) |
| Status `LOGIN_REQUIRED` | Normal after a bank password change or expiry: use **Reconnect bank** |
| Sync says "already running" | Another sync is in progress; a crashed run frees itself after 10 minutes |
