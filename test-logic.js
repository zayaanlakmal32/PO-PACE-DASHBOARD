// Standalone sanity test: runs the same classification + message-building
// logic against the real cards from Zayaan's Sep 8 example, to confirm the
// output matches what he expects before this ever touches live Notion data.

const HARD_OK_STATUSES = new Set(["Client Review", "Need posting", "PUBLISHED"]);
const IGNORE_STATUSES = new Set(["PUBLISHED", "On Hold", "Do Not Progress"]);
const EARLY_STAGE_STATUSES = new Set(["Topics", "Need writing", "Writing", "Writing Review", "Need filming"]);

function classify(todayStr, publishDate, status) {
  if (IGNORE_STATUSES.has(status)) return null;
  const daysUntil = Math.round(
    (new Date(publishDate + "T00:00:00Z") - new Date(todayStr + "T00:00:00Z")) / 86400000
  );
  if (daysUntil <= 1 && !HARD_OK_STATUSES.has(status)) return { flag: "hard", daysUntil };
  if (daysUntil >= 2 && EARLY_STAGE_STATUSES.has(status)) return { flag: "soft", daysUntil };
  return null;
}

function fmtDate(dateStr) {
  const d = new Date(dateStr + "T00:00:00Z");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function cardLine(name, publishDate, status, flag, daysUntil) {
  const icon = flag === "hard" ? "⚠️" : "👀";
  let when, note;
  if (daysUntil <= 0) {
    when = `publishes today (${fmtDate(publishDate)})`;
    const yesterday = new Date(new Date(publishDate + "T00:00:00Z").getTime() - 86400000).toISOString().slice(0, 10);
    note = `still "${status}" (should've hit "Need posting" by ${fmtDate(yesterday)})`;
  } else if (daysUntil === 1) {
    when = `publishes tomorrow (${fmtDate(publishDate)})`;
    note = `still "${status}" (should be "Need posting" as of today)`;
  } else {
    when = `publishes ${fmtDate(publishDate)}`;
    note = `still "${status}" — heads-up, behind pace, follow up to speed up`;
  }
  return `${icon} ${name} — ${when}, ${note}`;
}

const today = "2026-09-08"; // real Notion data + real "today" pulled during this session

const cases = [
  ["How to build your own jarvis in 30 seconds", "2026-09-08", "Need editing"], // real card, real status
  ["Student demo v02", "2026-09-09", "Need editing"],
  ["rapid tools", "2026-09-10", "Need writing"],
  ["$10 Billion industry", "2026-09-11", "Need filming"],
  ["Published one, should NOT flag", "2026-09-08", "PUBLISHED"],
  ["On track hard case, should NOT flag", "2026-09-08", "Need posting"],
  ["Editing 2 days out, should NOT flag (soft only covers early stages)", "2026-09-10", "Need editing"],
];

let pass = true;
for (const [name, publishDate, status] of cases) {
  const result = classify(today, publishDate, status);
  if (result) {
    console.log(cardLine(name, publishDate, status, result.flag, result.daysUntil));
  } else {
    console.log(`(not flagged) ${name} — ${publishDate}, ${status}`);
  }
}
