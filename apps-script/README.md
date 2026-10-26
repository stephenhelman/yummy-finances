# Yummy Finances mailer (Google Apps Script)

This small script sends the sign-in emails and the monthly P&L report. It runs on the **shop's Google account**, so there is no email service to pay for and no domain to verify. You do this once.

Limits to know: a normal Gmail account can send about **100 emails a day** through Apps Script (a Workspace account about 1,500). Login links and one monthly report are far below that.

## 1. Create the script

1. Signed in as the shop's Google account, go to <https://script.google.com> and click **New project**. Name it `Yummy Finances Mailer`.
2. Delete the sample code in `Code.gs` and paste in the whole of `apps-script/Code.gs` from this repo.
3. Click the gear (**Project Settings**) and tick **Show "appsscript.json" manifest file in editor**. Go back to the editor, open `appsscript.json`, and paste in the contents of `apps-script/appsscript.json` from this repo. Save.

## 2. Set the secret (and, optionally, a Drive folder)

In **Project Settings → Script properties → Add script property**:

| Property | Value |
|---|---|
| `APPS_SCRIPT_SECRET` | A long random string, at least 16 characters (for example, run `openssl rand -base64 32`). You will paste the *same* value into Vercel. |
| `DRIVE_FOLDER_ID` | Optional. Open the Drive folder for the reports; the id is the last part of its URL (`drive.google.com/drive/folders/THIS_PART`). Leave it out to use My Drive. |

## 3. Authorize it once

1. In the editor, choose the function `doGet` in the dropdown at the top and click **Run**.
2. Google asks for permission (send email, Drive, Sheets, external requests). Click **Review permissions**, choose the account, then **Advanced → Go to Yummy Finances Mailer (unsafe) → Allow**. ("Unsafe" only means Google has not reviewed a private script you wrote.)

## 4. Deploy it

1. **Deploy → New deployment**. Click the gear next to "Select type" and choose **Web app**.
2. **Execute as: Me.** **Who has access: Anyone.** (The secret, not the link, is what keeps strangers out.)
3. Click **Deploy** and copy the **Web app URL** (it ends in `/exec`).

That URL is `APPS_SCRIPT_URL`; the secret from step 2 is `APPS_SCRIPT_SECRET`. Put both in Vercel (see `DEPLOY.md`) and in your local `.env`.

## 5. Check it

Run `npm run preflight`. The `apps script: ping` line should pass. A failure message says what is wrong:

- *"returned a web page, not JSON"*: the deployment is not set to "Anyone", or you used a URL that does not end in `/exec`.
- *"unauthorized"*: the secret in Vercel/`.env` differs from the script property.

## Changing the script later

Editing the code does **not** change the live web app. After any edit: **Deploy → Manage deployments → pencil icon → Version: New version → Deploy**. The URL stays the same.

## What the script accepts

Every request is a JSON `POST` with `secret` and `type`; anything without the right secret gets `{"ok":false,"error":"unauthorized"}`.

- `ping`: returns `{"ok":true}`.
- `login_email`: `{to, link, expiresMinutes}`; sends the sign-in email.
- `monthly_report`: `{year, month, businessName, sections[], lines[], netCents?, cashNotes[], warnings[], recipients[]}` (money as integer cents). Gets or creates the workbook `Yummy Finances {year}` in the Drive folder, creates or **replaces** the tab `YYYY-MM` (so re-sending a month never duplicates it), rebuilds the `YTD Summary` tab (one column per month, plus a total), and emails the recipients that month's tab as a PDF plus the workbook link.
