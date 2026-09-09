// api/_lib/cadence.js
//
// Reads the "Client Posting Cadence & Non-Negotiables" Google Sheet POs fill
// in, and turns each client's free-text "Content Ready-By (Client Review)"
// column into a number of days-before-publish the pace rule should use for
// that client, instead of the flat 24hr default everyone used before.
//
// Requires GOOGLE_SHEETS_API_KEY env var (a Google Cloud API key restricted
// to the Sheets API - no OAuth/service account needed). The sheet itself
// must be shared as "Anyone with the link -> Viewer" for a plain API key to
// read it. If the key is missing, or the sheet can't be reached, every
// client just falls back to the default lead time - nothing breaks, it just
// behaves exactly like it did before this feature existed.
//
// File prefixed with "_" so Vercel does NOT turn this into its own route -
// it's a plain helper module required by api/flags.js.

const DEFAULT_LEAD_DAYS = 1; // matches the original flat 24hr rule
const CADENCE_SHEET_ID_DEFAULT = "1EKjDPil1iwEd_AlGLaIDQpUIpCSjHjUyn7OSheNpFLg";
const CADENCE_SHEET_TAB_DEFAULT = "Template";

async function fetchSheetRows(apiKey, sheetId, tabName) {
  const range = encodeURIComponent(`${tabName}!A:J`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}?key=${apiKey}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    const err = new Error(`Google Sheets fetch failed (${resp.status}): ${text.slice(0, 300)}`);
    err.status = resp.status;
    throw err;
  }
  const data = await resp.json();
  return data.values || [];
}

// "2 days before each scheduled post date" -> 2, "a day before posting" -> 1,
// anything it can't confidently read -> null (caller falls back to default).
function parseLeadDays(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  const numMatch = t.match(/(\d+)\s*day/);
  if (numMatch) return parseInt(numMatch[1], 10);
  if (/\ba day\b|\bone day\b|\bday before\b/.test(t)) return 1;
  return null;
}

function isExampleRow(row) {
  return row.some((cell) => /example\s+(po|client)/i.test(cell || "") || /example row/i.test(cell || ""));
}

function findCol(header, ...needles) {
  return header.findIndex((h) => needles.some((n) => h.includes(n)));
}

// Returns { map, headerFound, rowCount }.
// map: clientNameLower -> { clientName, po, readyByText, leadDays (or null) }
function parseCadenceRows(rows) {
  const headerIdx = rows.findIndex((r) => (r || []).some((c) => /client name/i.test(c || "")));
  if (headerIdx === -1) return { map: new Map(), headerFound: false, rowCount: 0 };

  const header = rows[headerIdx].map((h) => (h || "").trim().toLowerCase());
  const idx = {
    po: findCol(header, "po name"),
    client: findCol(header, "client name"),
    readyBy: findCol(header, "content ready-by", "ready-by", "client review"),
  };
  if (idx.client === -1) return { map: new Map(), headerFound: false, rowCount: 0 };

  const map = new Map();
  let rowCount = 0;
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || !row.length) continue;
    if (isExampleRow(row)) continue;
    const clientName = (row[idx.client] || "").trim();
    if (!clientName) continue;
    rowCount++;

    const readyByText = idx.readyBy !== -1 ? (row[idx.readyBy] || "").trim() : "";
    const leadDays = parseLeadDays(readyByText);
    const key = clientName.toLowerCase();
    const existing = map.get(key);
    const entry = {
      clientName,
      po: idx.po !== -1 ? (row[idx.po] || "").trim() : "",
      readyByText,
      leadDays,
    };
    // A client can have more than one active-phase row (the sheet's own
    // instructions say to use a separate row per phase) - keep the stricter
    // (smaller) lead time so mixed phases never cause under-flagging.
    if (!existing || (entry.leadDays != null && (existing.leadDays == null || entry.leadDays < existing.leadDays))) {
      map.set(key, entry);
    }
  }
  return { map, headerFound: true, rowCount };
}

async function getCadenceMap() {
  const apiKey = process.env.GOOGLE_SHEETS_API_KEY;
  const sheetId = process.env.CADENCE_SHEET_ID || CADENCE_SHEET_ID_DEFAULT;
  const tabName = process.env.CADENCE_SHEET_TAB || CADENCE_SHEET_TAB_DEFAULT;

  if (!apiKey) {
    return {
      map: new Map(),
      ok: false,
      error: "GOOGLE_SHEETS_API_KEY not set - every client is using the default lead time.",
    };
  }
  try {
    const rows = await fetchSheetRows(apiKey, sheetId, tabName);
    const { map, headerFound, rowCount } = parseCadenceRows(rows);
    if (!headerFound) {
      return { map: new Map(), ok: false, error: `Couldn't find a "Client Name" header on the "${tabName}" tab.` };
    }
    return { map, ok: true, error: null, rowCount };
  } catch (e) {
    return { map: new Map(), ok: false, error: e.message };
  }
}

module.exports = { getCadenceMap, DEFAULT_LEAD_DAYS, parseLeadDays };
