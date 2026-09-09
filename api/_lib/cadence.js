// api/_lib/cadence.js
//
// Reads the "Client Posting Cadence & Non-Negotiables" Google Sheet POs fill
// in, and turns each client's free-text "Content Ready-By (Client Review)"
// column into a number of days-before-publish the pace rule should use for
// that client, instead of the flat 24hr default everyone used before.
//
// No Google Cloud API key or service account needed. This reads the sheet
// through Google's public CSV export endpoint (the same mechanism behind
// "File -> Share -> Publish to web", just addressed directly by sheet name
// instead of needing to actually publish it), which works for any sheet
// shared as "Anyone with the link -> Viewer" - already set up on this sheet.
// If the sheet's sharing is ever locked back down to "Restricted," this will
// start failing and every client just falls back to the default lead time -
// nothing breaks, cadenceStatus.connected will just read false and the
// dashboard banner will say why.

const DEFAULT_LEAD_DAYS = 1; // matches the original flat 24hr rule
const CADENCE_SHEET_ID_DEFAULT = "1EKjDPil1iwEd_AlGLaIDQpUIpCSjHjUyn7OSheNpFLg";
const CADENCE_SHEET_TAB_DEFAULT = "Template";

function csvUrl(sheetId, tabName) {
  return `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tabName)}`;
}

// Minimal CSV parser - handles quoted fields, escaped quotes (""), and
// commas/newlines inside quotes. Good enough for a Sheets CSV export.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

async function fetchSheetRows(sheetId, tabName) {
  const resp = await fetch(csvUrl(sheetId, tabName));
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    const err = new Error(
      `Couldn't read the cadence sheet (${resp.status}). Make sure it's shared as "Anyone with the link -> Viewer". ${text.slice(0, 200)}`
    );
    err.status = resp.status;
    throw err;
  }
  const text = await resp.text();
  const rows = parseCsv(text);
  // A sheet that's NOT link-shared returns a 200 with an HTML sign-in page
  // instead of CSV - detect that so it shows up as a clear error, not
  // silently as "0 rows found."
  if (rows.length && rows[0].some((c) => /<html|accounts\.google\.com/i.test(c || ""))) {
    throw new Error(`Got an HTML sign-in page instead of CSV - the sheet isn't shared as "Anyone with the link" yet.`);
  }
  return rows;
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
  const sheetId = process.env.CADENCE_SHEET_ID || CADENCE_SHEET_ID_DEFAULT;
  const tabName = process.env.CADENCE_SHEET_TAB || CADENCE_SHEET_TAB_DEFAULT;

  try {
    const rows = await fetchSheetRows(sheetId, tabName);
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
