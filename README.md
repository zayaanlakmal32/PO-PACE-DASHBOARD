# PO Pace Flags Dashboard

Scans every **active** client (Project Tracker `Stage` not "On Hold"/"Offboarded")
and flags Content Board cards that are behind the pace rule:

- ⚠️ **Hard flag** — Publish Date is today or tomorrow, and Status is not
  "Client Review", "Need posting", or "PUBLISHED".
- 👀 **Heads-up flag** — Publish Date is 2+ days out (within the lookahead
  window, default 5 days) and Status is still an early-stage one ("Topics",
  "Need writing", "Writing", "Writing Review", "Need filming").

Output is grouped by PO → Client, matches the Slack message format you use
today, and has a one-click "Copy for Slack" button per PO (and one for the
whole list).

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
4. Deploy. Open the URL — it loads and scans automatically.

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
