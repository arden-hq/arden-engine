---
name: google-setup
description: Set up the user's own Google Cloud client so Arden can connect Gmail, Calendar and Drive. Use when the user wants to connect Google and Arden has no Google client yet, or before calling `google_client_import`.
version: 1.0.0
tool_group: Google setup
---

# Google setup

Say this first, in your own words: "Google asks every app for its own key. I'll make yours in Google Cloud: I do the clicks, you sign in and approve."

## Rules

- Work in the integrated browser; load the browser Skill before the first Browser call.
- Never type the user's email, password, codes or anything on a sign-in page. When a page asks for them, stop and ask the user.
- Ask which services they want before you start: Gmail, Calendar, Drive, or all three.
- Say what each step is for in one short line before doing it. Keep going on your own between the stops below.
- If a page does not look like these steps describe, snapshot it, find the matching control, and continue; ask the user only when you are truly stuck.

## Steps

1. Open `https://console.cloud.google.com/` with `browser_open`. If it shows a sign-in page, `ask_user` "Sign in to the account you want me to use, then press Continue." with the choice "Continue", and wait for the answer.
2. Create a new project named "Arden" (accept Google's terms only if the user agrees; ask them). Make sure it is the selected project.
3. Enable the APIs they chose, from "APIs & Services" → Library: Gmail API, Google Calendar API, Google Drive API.
4. Set up the consent screen (Google Auth Platform → Branding / Audience): app name "Arden", the signed-in email as the support and contact email, user type External. Add the signed-in account as a test user.
5. Explain the publishing choice and `ask_user` which they want: in Testing, Google signs Arden out every 7 days; in Production, the sign-in lasts, and Google warns that the app is unverified, which is expected for your own app (under 100 users it needs no review). Change the publishing status only to what they chose.
6. Create an OAuth client (Clients → Create client) of type Desktop app, named "Arden", and download its JSON.
7. Call `google_client_import` (it reads the newest `client_secret_*.json` in ~/Downloads). If it reports the client is blocked because accounts are already connected, tell the user and stop.
8. Connect each chosen service. Before the first, warn: "Google will warn that the app isn't verified. It's your own app, so that's expected." Then make one small read on that service: `calendar_search` for today, `email_search` for a recent message, or `drive_search` for a recent file. When the service is not connected yet, that call shows the user a Connect card; they approve in Google, and the call continues. Confirm each connection with `google_accounts_list`.
9. Finish with one line naming what is connected, and offer one thing to do with it.
