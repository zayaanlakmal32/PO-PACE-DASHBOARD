# PO Pace Flags Dashboard

Scans every **active** client (Project Tracker `Stage` not "On Hold"/"Offboarded")
and flags Content Board cards that are behind the pace rule:

- ⚠️ **Hard flag** — Publish Date is within the client's own review lead
  time (see below), and Status is not one that counts as "done" for that
  board (each board's own Notion "Complete" statuses, plus "Client Review"
  and "\<Name\>'s review" style stages).
- 👀 **Heads-up flag** — Publish Date is further out than that lead time but
  within the lookahead window (default 5 days), and Status is still an
  early-stage one ("Topics", "Need writing", "Writing", "Writing Review",
  "Need filming").

Output is grouped by PO → Client, matches the Slack message format you use
today, and has a one-click "Copy for Slack" button per PO (and one for the
whole list).

## Per-client review lead time (cadence sheet)

The flat "24 hours before publish" rule was a starting default. It now reads
each client's own required lead time from the **"Client Posting Cadence &
Non-Negotiables"** Google Sheet POs fill in (the `Content Ready-By (Client
Review)` column, e.g. "2 days before" or "a day before"). A client with a row
there and a lead time that can be confidently read from that text uses their
own number; a client with no row, or one that can't be confidently parsed
(e.g. "Every Monday" isn't a lead time), falls back to the original 24hr
default — nothing goes unmonitored just because a PO hasn't filled it in
yet. The "Full scan results" table on the dashboard shows exactly which rule
each client is on, and the banner at the top shows whether the sheet
connection is actually working.

This does **not** yet check posting *volume* (e.g. whether a client is
actually hitting "6 posts/week") — only the review-lead-time part of the
sheet. That'd be a separate addition if you want it later.

## How it finds clients and their boards

It reads the **Project Tracker** database directly (`Client Name`, `PO Name`,
`Stage`, `Content Board Data Source ID`) — no separate client list needed.
For each active client it queries their Content Board using the data source
ID already stored on that row.

## Deploy (same pattern as your other Editoz dashboards)

1. Push this folder to a new GitHub repo (e.g. `editoz-po-pace-dashboard`).
2. Import it into Vercel as a new project (framework preset: "Other" — no
   build step needed).
3. In Vercel Project Settings → Environment Variables, add:
   - `NOTION_TOKEN` — the same Notion integration token your other
     dashboards use.
   - `GOOGLE_SHEETS_API_KEY` — optional, but needed for the per-client
     cadence rule above. See "Setting up the cadence sheet connection" below
     for how to get this. If you skip it, everything still works, every
     client just uses the flat 24hr default.
4. Deploy. Open the URL — it loads and scans automatically.

## Setting up the cadence sheet connection

This is a one-time setup, done in Google Cloud Console (not Vercel or
Notion):

1. Make sure the cadence sheet itself is link-shareable: open it → **Share**
   → **General access** → set to "Anyone with the link" → **Viewer**. (It
   only needs to be *readable* via link, not editable — POs still edit it
   normally, they're already logged into their own Google account when they
   do.)
2. Go to [Google Cloud Console](https://console.cloud.google.com/) → create
   a project (or use an existing one) → **APIs & Services** → **Library** →
   search "Google Sheets API" → **Enable**.
3. **APIs & Services** → **Credentials** → **Create Credentials** → **API
   key**. Copy the key it gives you.
4. (Recommended) Click into that new key → under "API restrictions" choose
   "Restrict key" → select only "Google Sheets API". This stops the key
   from being usable for anything else if it ever leaked.
5. In Vercel → this project → Settings → Environment Variables, add
   `GOOGLE_SHEETS_API_KEY` = the key from step 3. Redeploy.
6. Open the dashboard — the banner at the top should turn green ("Cadence
   sheet connected — N client row(s) read"). If it's red instead, the error
   message it shows will say why (usually: sheet not link-shared yet, or
   the API isn't enabled).

If you'd rather not make the sheet link-shareable at all, the alternative is
a Google service account (private, no public link needed) — that's more
setup (a JSON key + a different auth flow), so ask me if you want that
version instead.

## Before trusting the full run

The integration token needs access to the Project Tracker **and** every
client's Content Board. If your token already powers editoz-dashboard-po,
it very likely already has this (they all live under the same shared
workspace tree), but the first run is the real test.

Use the **"Test single client"** box on the page (try `Kavindu`, since
that's the example you gave me) before trusting the full list — it'll only
scan that one client's board, so you can check the output against what you
already know is true on that board.

If a client shows up under "skipped," their Project Tracker row is missing
a `Content Board Data Source ID`. If a client shows up under "errored,"
either the token doesn't have access to their board yet, or that board's
`Status`/`Publish Date`/`Name` properties are named differently than
Kavindu's (a few boards may have drifted from the template) — the error
message will say which.

## Notes / things I couldn't verify from my side

I built and validated this against the real schema (Project Tracker +
Kavindu's Content Board, including your actual "Ashen / Kavindu / How to
build your own jarvis" example — it produces exactly the flag you expected).
But I don't hold your Notion integration token in this session, so I
couldn't run the deployed function end-to-end myself. The single-client
test mode above is there so you can verify the first live run before
relying on the full 35-client scan.
