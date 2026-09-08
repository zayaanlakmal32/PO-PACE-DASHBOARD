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
// Not every client's Content Board uses the same template. Accelerate boards
// use "Publish Date" / "Need writing" / "Need posting" style names; some DFY
// boards use "Publishing date" / "Ready to write" / "To be published" style
// names instead. Rather than hardcoding one schema, this file:
//   1. tries a short list of known date-property names per client, and
//   2. matches statuses by a case-insensitive phrase lookup instead of an
//      exact list, so both templates (and small variations) are covered.

const NOTION_VERSION = "2025-09-03"; // multi-data-source API
const PROJECT_TRACKER_DS = "b6b396fe-f0cf-4d7e-9845-e18c630c0ae7";

// Known Publish-Date property name variants, tried in order.
const DATE_PROP_CANDIDATES = ["Publish Date", "Publishing date", "Publish date", "Publication Date"];

// Case-insensitive status phrase matching (covers multiple board templates).
const HARD_OK_MATCH = new Set(["client review", "need posting", "published", "to be published", "ready to post", "ready to publish"]);
const IGNORE_MATCH = new Set(["published", "on hold", "do not progress"]);
const EARLY_STAGE_MATCH = new Set([
  "topics",
  "ideas",
  "ideas approved",
  "need writing",
  "ready to write",
  "writing",
  "writing review",
  "need filming",
  "ready to film",
]);

const EXCLUDED_CLIENT_STAGES = new Set(["On Hold", "Offboarded"]);

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

// Tries each candidate date-property name until one works. Stops immediately
// (no wasted retries) on errors that aren't about a missing property, e.g. a
// 404 because the board isn't shared with the integration.
async function queryClientCards(token, dataSourceId, todayStr, windowEndStr) {
  let lastErr;
  for (const dateProp of DATE_PROP_CANDIDATES) {
    try {
      const cards = await queryAllPages(token, dataSourceId, {
        filter: {
          and: [
            { property: dateProp, date: { on_or_after: todayStr } },
            { property: dateProp, date: { on_or_before: windowEndStr } },
          ],
        },
        sorts: [{ property: dateProp, direction: "ascending" }],
      });
      return { cards, dateProp };
    } catch (e) {
      lastErr = e;
      const isPropertyIssue = e.status === 400 && /property/i.test(e.body || "");
      if (!isPropertyIssue) throw e; // e.g. 404 not shared - retrying with another name won't help
    }
  }
  throw lastErr;
}

function getTitle(page, propName) {
  const prop = page.properties?.[propName];
  if (!prop?.title) return "";
  return prop.title.map((t) => t.plain_text).join("");
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
function getStatus(page, propName) {
  const prop = page.properties?.[propName];
  return prop?.status ? prop.status.name : null;
}
function getDate(page, propName) {
  const prop = page.properties?.[propName];
  return prop?.date ? prop.date.start : null;
}

function isoDateOnly(d) {
  return d.toISOString().slice(0, 10);
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
      clients = clients.filter((c) => c.clientName.toLowerCase() === onlyClient);
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
        const { cards, dateProp } = await queryClientCards(token, client.contentBoardDsId, todayStr, windowEndStr);

        for (const card of cards) {
          const name = getTitle(card, "Name");
          const status = getStatus(card, "Status");
          const publishDate = getDate(card, dateProp);
          if (!publishDate || !status) continue;

          const statusKey = status.trim().toLowerCase();
          if (IGNORE_MATCH.has(statusKey)) continue;

          const daysUntil = Math.round(
            (new Date(publishDate + "T00:00:00Z") - new Date(todayStr + "T00:00:00Z")) / 86400000
          );

          let flag = null;
          if (daysUntil <= 1 && !HARD_OK_MATCH.has(statusKey)) {
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
