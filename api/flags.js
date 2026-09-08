// api/flags.js
//
// Scans every active client's Content Board (via the Project Tracker) and
// flags cards that are behind the "PO must keep the next post ready 24hrs
// before publish" rule.
//
// Env vars required (set in Vercel Project Settings -> Environment Variables):
//   NOTION_TOKEN  - same Notion integration token used by the other Editoz
//                   dashboards. It must be shared with the Project Tracker
//                   AND with every client's Content Board page (Notion
//                   integrations only see pages explicitly shared with them
//                   - share the client's "Content Production Engine" page
//                   and the Content Board underneath it is covered too).
//
// Optional query params:
//   ?client=Kavindu   - only scan one client, for testing/verification
//   ?days=5           - how many days ahead to scan for the heads-up tier (default 5)
//
// Every client's Content Board is a separately-built Notion database, and
// several (mostly DFY clients) use completely custom Status vocabularies -
// e.g. one board's "done" status is literally called "Done", another calls
// its client-review stage "DL's review". Rather than hardcoding status
// names, this file reads each board's OWN Notion "Complete" status group
// (already configured by whoever built that board) to know which statuses
// mean "nothing left to do here" - plus a couple of small curated
// additions ("Client Review" and "<Name>'s review" style stages, which
// Notion doesn't mark Complete but the pace rule treats as fine) and a
// best-effort phrase list for the "still early stage" heads-up tier.

const NOTION_VERSION = "2025-09-03"; // multi-data-source API
const PROJECT_TRACKER_DS = "b6b396fe-f0cf-4d7e-9845-e18c630c0ae7";

// Fallback date-property name candidates, used only if a board's schema
// doesn't have an obviously-named "...publish..." date property.
const DATE_PROP_FALLBACKS = ["Publish Date", "Publishing date", "Publish date", "Publication Date"];

// Always treated as "nothing left for the PO to do", regardless of what a
// given board's own Notion status groups say.
const STATIC_SAFE_MATCH = new Set(["client review", "on hold", "do not progress", "do not progress "]);

// Best-effort "still early stage" phrase list for the softer heads-up tier.
// Every variant actually seen across Accelerate + DFY boards so far.
const EARLY_STAGE_MATCH = new Set([
  "topics",
  "ideas",
  "ideas approved",
  "need writing",
  "needs writing",
  "ready to write",
  "writing",
  "writing review",
  "need filming",
  "needs filming",
  "ready to film",
]);

const EXCLUDED_CLIENT_STAGES = new Set(["On Hold", "Offboarded"]);

async function notionGet(token, path) {
  const resp = await fetch(`https://api.notion.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
    },
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    const err = new Error(`Notion GET failed (${resp.status}): ${text.slice(0, 300)}`);
    err.status = resp.status;
    err.body = text;
    throw err;
  }
  return resp.json();
}

async function notionQuery(token, dataSourceId, body) {
  const resp = await fetch(`https://api.notion.com/v1/data_sources/${dataSourceId}/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body || {}),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    const err = new Error(`Notion query failed (${resp.status}): ${text.slice(0, 300)}`);
    err.status = resp.status;
    err.body = text;
    throw err;
  }
  return resp.json();
}

async function queryAllPages(token, dataSourceId, body) {
  let results = [];
  let cursor;
  do {
    const payload = cursor ? { ...body, start_cursor: cursor } : body;
    const data = await notionQuery(token, dataSourceId, payload);
    results = results.concat(data.results || []);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return results;
}

// Reads a board's own property schema: which property is the title, which
// is the Status, which date property is "publish date", and - crucially -
// that board's own Notion "Complete" status group (its own definition of
// "done"), so we never have to guess a board's status vocabulary.
async function getBoardSchema(token, dataSourceId) {
  const ds = await notionGet(token, `/v1/data_sources/${dataSourceId}`);
  const props = ds.properties || {};

  let titleProp = null;
  let statusProp = null;
  let dateProp = null;
  const safeStatuses = new Set();

  for (const [name, def] of Object.entries(props)) {
    if (def.type === "title" && !titleProp) titleProp = name;
    if (def.type === "status" && !statusProp) {
      statusProp = name;
      const options = def.status?.options || [];
      const groups = def.status?.groups || [];
      const idToName = new Map(options.map((o) => [o.id, o.name]));
      for (const g of groups) {
        if (/complete/i.test(g.name || "")) {
          for (const optId of g.option_ids || []) {
            const optName = idToName.get(optId);
            if (optName) safeStatuses.add(optName.trim().toLowerCase());
          }
        }
      }
    }
    if (def.type === "date" && !dateProp && /publish/i.test(name)) dateProp = name;
  }

  if (!titleProp) titleProp = "Name";
  return { titleProp, statusProp, dateProp, safeStatuses };
}

// Falls back to trying known date-property name variants if schema-based
// detection didn't find an obviously-named one.
async function resolveDateProp(token, dataSourceId, schema) {
  if (schema.dateProp) return schema.dateProp;
  for (const candidate of DATE_PROP_FALLBACKS) {
    try {
      await queryAllPages(token, dataSourceId, {
        filter: { property: candidate, date: { is_not_empty: true } },
        page_size: 1,
      });
      return candidate;
    } catch (e) {
      // try next candidate
    }
  }
  return null;
}

function getTitle(page, propName) {
  const prop = page.properties?.[propName];
  if (!prop?.title) return "";
  return prop.title.map((t) => t.plain_text).join("");
}
function getStatus(page, propName) {
  const prop = page.properties?.[propName];
  return prop?.status ? prop.status.name : null;
}
function getDate(page, propName) {
  const prop = page.properties?.[propName];
  return prop?.date ? prop.date.start : null;
}
function getRichText(page, propName) {
  const prop = page.properties?.[propName];
  if (!prop?.rich_text) return "";
  return prop.rich_text.map((t) => t.plain_text).join("");
}
function getSelect(page, propName) {
  const prop = page.properties?.[propName];
  return prop?.select ? prop.select.name : null;
}

function isoDateOnly(d) {
  return d.toISOString().slice(0, 10);
}

function isSafeStatus(statusKey, boardSafeStatuses) {
  if (boardSafeStatuses.has(statusKey)) return true;
  if (STATIC_SAFE_MATCH.has(statusKey)) return true;
  if (/'s review$/.test(statusKey)) return true; // e.g. "DL's review"
  return false;
}

module.exports = async (req, res) => {
  const token = process.env.NOTION_TOKEN;
  if (!token) {
    res.status(500).json({ error: "NOTION_TOKEN env var is not set." });
    return;
  }

  const onlyClient = (req.query?.client || "").trim().toLowerCase();
  const windowDays = Math.max(1, Math.min(14, parseInt(req.query?.days, 10) || 5));

  try {
    // 1. Active clients from Project Tracker
    const trackerRows = await queryAllPages(token, PROJECT_TRACKER_DS, {});

    let clients = trackerRows
      .map((row) => ({
        clientName: getTitle(row, "Client Name"),
        poName: getSelect(row, "PO Name"),
        stage: getSelect(row, "Stage"),
        contentBoardDsId: getRichText(row, "Content Board Data Source ID").trim(),
      }))
      .filter((c) => c.clientName && !EXCLUDED_CLIENT_STAGES.has(c.stage));

    if (onlyClient) {
  clients = clients.filter((c) => c.clientName.toLowerCase().includes(onlyClient));
}

    const skipped = clients
      .filter((c) => !c.contentBoardDsId)
      .map((c) => ({ client: c.clientName, reason: "No Content Board Data Source ID set in Project Tracker" }));
    clients = clients.filter((c) => c.contentBoardDsId);

    // 2. Scan each client's Content Board for upcoming cards
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const todayStr = isoDateOnly(today);
    const windowEnd = new Date(today);
    windowEnd.setUTCDate(windowEnd.getUTCDate() + windowDays);
    const windowEndStr = isoDateOnly(windowEnd);

    const flags = [];
    const errors = [];

    for (const client of clients) {
      try {
        const schema = await getBoardSchema(token, client.contentBoardDsId);
        const dateProp = await resolveDateProp(token, client.contentBoardDsId, schema);
        if (!dateProp) throw new Error(`Couldn't find a "publish date" style date property on this board.`);
        if (!schema.statusProp) throw new Error(`Couldn't find a Status property on this board.`);

        const cards = await queryAllPages(token, client.contentBoardDsId, {
          filter: {
            and: [
              { property: dateProp, date: { on_or_after: todayStr } },
              { property: dateProp, date: { on_or_before: windowEndStr } },
            ],
          },
          sorts: [{ property: dateProp, direction: "ascending" }],
        });

        for (const card of cards) {
          const name = getTitle(card, schema.titleProp);
          const status = getStatus(card, schema.statusProp);
          const publishDate = getDate(card, dateProp);
          if (!publishDate || !status) continue;

          const statusKey = status.trim().toLowerCase();
          if (isSafeStatus(statusKey, schema.safeStatuses)) continue;

          const daysUntil = Math.round(
            (new Date(publishDate + "T00:00:00Z") - new Date(todayStr + "T00:00:00Z")) / 86400000
          );

          let flag = null;
          if (daysUntil <= 1) {
            flag = "hard";
          } else if (daysUntil >= 2 && EARLY_STAGE_MATCH.has(statusKey)) {
            flag = "soft";
          }

          if (flag) {
            flags.push({
              po: client.poName || "Unassigned",
              client: client.clientName,
              cardName: name || "(untitled card)",
              cardUrl: card.url,
              status,
              publishDate,
              daysUntil,
              flag,
            });
          }
        }
      } catch (e) {
        errors.push({ client: client.clientName, error: e.message });
      }
    }

    flags.sort((a, b) => {
      if (a.flag !== b.flag) return a.flag === "hard" ? -1 : 1;
      return a.publishDate.localeCompare(b.publishDate);
    });

    res.status(200).json({
      generatedAt: new Date().toISOString(),
      today: todayStr,
      windowDays,
      clientsScanned: clients.length,
      flags,
      skipped,
      errors,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
