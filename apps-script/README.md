# Yummy Finances mailer (Google Apps Script)

This small script sends the sign-in emails and the monthly P&L report. It runs on **Stephen's Google account**, so there is no email service to pay for and no domain to verify. The script, the report workbooks and the Drive folder all live on that account, and the folder is **shared with the owner** (step 2). You do this once.

Limits to know: a normal Gmail account can send about **100 emails a day** through Apps Script (a Workspace account about 1,500). Login links and one monthly report are far below that.

## 1. Create the script

1. Signed in as Stephen's Google account, go to <https://script.google.com> and click **New project**. Name it `Yummy Finances Mailer`.
2. Delete the sample code in `Code.gs` and paste in the whole of `apps-script/Code.gs` from this repo.
3. Click the gear (**Project Settings**) and tick **Show "appsscript.json" manifest file in editor**. Go back to the editor, open `appsscript.json`, and paste in the contents of `apps-script/appsscript.json` from this repo. Save.

## 2. Set the secret (and, optionally, a Drive folder)

In **Project Settings → Script properties → Add script property**:

| Property | Value |
|---|---|
| `APPS_SCRIPT_SECRET` | A long random string, at least 16 characters (for example, run `openssl rand -base64 32`). You will paste the *same* value into Vercel. |
| `DRIVE_FOLDER_ID` | Optional. Open the Drive folder for the reports; the id is the last part of its URL (`drive.google.com/drive/folders/THIS_PART`). Leave it out to use My Drive. Create the folder on Stephen's account and **share it with the owner** (Share → add their email as Viewer or Editor), so they can open the yearly workbooks. |

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

## Changing the script later: publish a NEW VERSION of the SAME deployment

Editing the code in the editor does **not** change the live web app, and creating a **New deployment** gives you a **different `/exec` URL** (which would break `APPS_SCRIPT_URL`). To update it and keep the URL:

1. In the script editor, paste the new `Code.gs` over the old one (and `appsscript.json` if it changed). **Save** (Ctrl/Cmd+S).
2. Click **Deploy → Manage deployments**.
3. Click the **pencil (Edit)** icon on the existing **Web app** deployment (not "New deployment").
4. In **Version**, choose **New version**. Add a short description, e.g. `notice type, TEST reports`.
5. Leave **Execute as: Me** and **Who has access: Anyone** as they are, then click **Deploy**.
6. Check the Web app URL shown is the **same** one as before (it ends in the same `/exec`). Nothing changes in Vercel.
7. If Google asks for new permissions (it does when the code starts using a new service), approve them once: run `doGet` from the editor, or follow the prompt.
8. From the repo, run `npm run preflight`: `apps script: ping` should pass. To check the new `notice` type end to end, press **Send test report** on any month in Reports (it uses `monthly_report` with `test: true`).

If the app reports `unknown type`, the live deployment is still on the old version: repeat steps 2 to 5 and make sure **New version** was selected.

## What the script accepts

Every request is a JSON `POST` with `secret` and `type`; anything without the right secret gets `{"ok":false,"error":"unauthorized"}`.

- `ping`: returns `{"ok":true}`.
- `login_email`: `{to, link, expiresMinutes}`; sends the sign-in email.
- `notice`: `{to[], subject, body}` (1 to 10 recipients, subject up to 150 characters, plain-text body up to 5,000). Sends a plain notification email: the review nudge on the 3rd, and "the report was not sent because ..." when the automatic close stops. The body is escaped, never treated as HTML.
- `monthly_report`: `{year, month, businessName, sections[], lines[], netCents?, cashNotes[], warnings[], recipients[], test?}` (money as integer cents). Gets or creates the workbook `Yummy Finances {year}` in the Drive folder, creates or **replaces** the tab `YYYY-MM` (so re-sending a month never duplicates it), rebuilds the `YTD Summary` tab (one column per month, plus a total), and emails the recipients that month's tab as a PDF plus the workbook link. With **`test: true`** everything goes to a **separate workbook named `Yummy Finances TEST {year}`**, the tab title reads `TEST - NOT A REAL REPORT`, the PDF is named `TEST ...`, the subject starts `[TEST]` and the email says it is a test, so a test can never be mistaken for, or overwrite, a real report.
