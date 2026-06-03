/* =====================================================================
   AV SLA Reporting Dashboard — server
   ---------------------------------------------------------------------
   Holds your SafetyCulture API token (server-side only, via an
   environment variable) and turns your Actions + Inspections into a
   client-friendly report. With no token set it serves sample data so
   you can see it working straight away.
   ===================================================================== */

import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

const SC_TOKEN = process.env.SC_API_TOKEN || "";
const SC_BASE = "https://api.safetyculture.io";

/* =====================================================================
   >>> THE ONE PLACE YOU MIGHT NEED TO EDIT <<<
   How your SafetyCulture fields map to the three fault categories and
   to your SLA targets. After your first live load, the dashboard shows
   a "Connection" line listing the exact priority and status words found
   in your account — copy those into the left-hand side here if they
   don't already match.
   ===================================================================== */
const CONFIG = {
  companyName: "Grant Thornton UK",

   reportStartDate: "2026-05-08T00:00:00Z",

  // SLA resolution targets, in hours
  targets: { "Room Down": 4, "Partial Fault": 24, Routine: 40 },

  // SafetyCulture Action PRIORITY  ->  fault category
  // (SC default priorities are usually High / Medium / Low — rename them
  //  in SafetyCulture to match your three categories, or remap here.)
  priorityToCategory: {
    high: "Room Down",
    medium: "Partial Fault",
    low: "Routine",
    "room down": "Room Down",
    "partial fault": "Partial Fault",
    routine: "Routine",
  },

  // Which Action STATUS words count as "closed"
  closedStatuses: ["complete", "completed", "closed", "done", "resolved"],

  // OPTIONAL: your two inspection template IDs, so the dashboard can tell
  // health checks from service-call reports. Leave blank to start — the
  // Connection panel will list the template IDs it sees so you can fill
  // these in. (Health-check count needs this; everything else works
  // without it.)
  healthCheckTemplateId: "template_58624410208f4025b0757d47d04008d1",
  serviceCallTemplateId: "template_320444bff169480eb03b995c615b70d4",
};

/* ----------------------------------------------------------------- utils */
const hoursBetween = (a, b) => (new Date(b) - new Date(a)) / 36e5;
const monthKey = (d) => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}`; };
const FAULTS = ["Room Down", "Partial Fault", "Routine"];

function last6Months() {
  const out = [];
  const d = new Date();
  for (let i = 5; i >= 0; i--) {
    const m = new Date(d.getFullYear(), d.getMonth() - i, 1);
    out.push({ key: monthKey(m), label: m.toLocaleDateString("en-GB", { month: "short" }) });
  }
  return out;
}

/* ----------------------------------------------------- SafetyCulture pull */
// Generic data-feed reader. SC feeds return { data:[...], metadata:{ next_page } }
// where next_page is a relative URL for the next batch.
async function pullFeed(feedPath) {
  const headers = { Authorization: `Bearer ${SC_TOKEN}`, Accept: "application/json" };
  let url = `${SC_BASE}${feedPath}`;
  const rows = [];
  let guard = 0;
  while (url && guard < 200) {
    guard++;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`SafetyCulture ${feedPath} returned ${res.status} ${res.statusText}`);
    const json = await res.json();
    if (Array.isArray(json.data)) rows.push(...json.data);
    const next = json.metadata && json.metadata.next_page;
    url = next ? `${SC_BASE}${next}` : null;
  }
  return rows;
}

function pick(obj, keys) { for (const k of keys) if (obj[k] != null && obj[k] !== "") return obj[k]; return null; }

async function buildLiveReport() {
  // Pull what we need. Sites give us readable room/site names.
  const [actions, inspections, sites] = await Promise.all([
    pullFeed("/feed/actions"),
    pullFeed("/feed/inspections").catch(() => []),
    pullFeed("/feed/sites").catch(() => []),
  ]);

console.log(
  "ALL ACTIONS:",
  JSON.stringify(
    actions.map(a => ({
      title: a.title,
      status: a.status,
      priority: a.priority,
      action_label: a.action_label,
      completed_at: a.completed_at
    })),
    null,
    2
  )
);
   
  const siteName = {};
  for (const s of sites) siteName[pick(s, ["id", "site_id"])] = pick(s, ["name", "site_name"]) || "—";

  const prioritiesFound = new Set();
  const statusesFound = new Set();
  const templatesFound = new Set();

  // ---- normalise actions into cases
  const cases = actions.map((a) => {
    const priorityRaw = (pick(a, ["priority", "priority_label", "priority_name"]) || "").toString();
    const statusRaw = (pick(a, ["status", "status_label", "status_name"]) || "").toString();
    prioritiesFound.add(priorityRaw || "(blank)");
    statusesFound.add(statusRaw || "(blank)");
    const created = pick(a, ["created_at", "created"]);
    const completed = pick(a, ["completed_at", "resolved_at"]);
    const modified = pick(a, ["modified_at", "updated_at"]);
    const isClosed = CONFIG.closedStatuses.includes(statusRaw.toLowerCase()) || !!completed;
    const fault = CONFIG.priorityToCategory[priorityRaw.toLowerCase()] || "Routine";
    const closedAt = isClosed ? (completed || modified) : null;
    const siteId = pick(a, ["site_id", "site"]);
    return {
      title: pick(a, ["title"]) || "Action",
      fault,
      status: isClosed ? "Closed" : "Open",
      created,
      closed: closedAt,
      room: siteName[siteId] || "—",
      resolution: pick(a, ["label", "labels"]) || null,
    };
  }).filter((c) => c.created);

  // ---- inspections -> health checks (needs template id to classify)
  inspections.forEach((i) => { const t = pick(i, ["template_id", "templateId"]); if (t) templatesFound.add(t); });
  const reportStartDate = new Date(CONFIG.reportStartDate);

const hcvRows = inspections
  .filter((i) =>
    pick(i, ["template_id", "templateId"]) === CONFIG.healthCheckTemplateId
  )
  .filter((i) => {
    const inspectionDate = new Date(
      pick(i, ["date_completed", "completed_at", "date_started", "created_at"])
    );
    return inspectionDate >= reportStartDate;
  })
  .map((i) => {
      const done = !!pick(i, ["date_completed", "completed_at"]);
      return {
        ref: (pick(i, ["audit_id", "inspection_id", "id"]) || "").toString().slice(-8),
        room: siteName[pick(i, ["site_id", "site"])] || "—",
        status: done ? "Completed" : "In Progress",
        scheduled: pick(i, ["created_at", "date_started"]),
        completed: pick(i, ["date_completed", "completed_at"]),
        notes: "",
      };
    });

  const report = computeMetrics(cases, hcvRows);
  report.meta.mode = "live";
  report.meta.connection = {
    actionsPulled: actions.length,
    inspectionsPulled: inspections.length,
    prioritiesFound: [...prioritiesFound],
    statusesFound: [...statusesFound],
    templatesFound: [...templatesFound].slice(0, 10),
  };
  return report;
}

/* --------------------------------------------------------- metric builder */
function computeMetrics(cases, hcvRows) {
  const months = last6Months();
  const curKey = months[months.length - 1].key;
  const t = CONFIG.targets;
  const closed = cases.filter((c) => c.status === "Closed" && c.closed);
  const open = cases.filter((c) => c.status === "Open");

  const trendLoggedClosed = months.map((m) => ({
    month: m.label,
    logged: cases.filter((c) => monthKey(c.created) === m.key).length,
    closed: closed.filter((c) => monthKey(c.closed) === m.key).length,
  }));

  const slaByCategory = FAULTS.map((f) => {
    const cc = closed.filter((c) => c.fault === f);
    const avg = cc.length ? cc.reduce((s, c) => s + hoursBetween(c.created, c.closed), 0) / cc.length : 0;
    return { fault: f, avg: +avg.toFixed(1), target: t[f], within: cc.length ? avg <= t[f] : true };
  });

  const slaTrend = months.map((m) => {
    const row = { month: m.label };
    FAULTS.forEach((f) => {
      const cc = closed.filter((c) => c.fault === f && monthKey(c.closed) === m.key);
      row[f] = cc.length ? +(cc.reduce((s, c) => s + hoursBetween(c.created, c.closed), 0) / cc.length).toFixed(1) : null;
    });
    return row;
  });

  const roomCount = {}; closed.forEach((c) => { roomCount[c.room] = (roomCount[c.room] || 0) + 1; });
  const topRooms = Object.entries(roomCount).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, value]) => ({ name, value }));

  const resCount = {}; closed.forEach((c) => { const r = c.resolution || "Other"; resCount[r] = (resCount[r] || 0) + 1; });
  const byResolution = Object.entries(resCount).map(([name, value]) => ({ name, value }));

  const openByCategory = {}; FAULTS.forEach((f) => { openByCategory[f] = open.filter((c) => c.fault === f).length; });
  const breaches = open.filter((c) => c.fault === "Room Down" && hoursBetween(c.created, new Date()) > t["Room Down"]).length;

  return {
    meta: { mode: "sample", generatedAt: new Date().toISOString(), company: CONFIG.companyName, monthsLabels: months.map((m) => m.label) },
    targets: t,
    kpis: {
      loggedThisMonth: cases.filter((c) => monthKey(c.created) === curKey).length,
      closedThisMonth: closed.filter((c) => monthKey(c.closed) === curKey).length,
      openNow: open.length,
      phoneCalls: 0,
    },
    openByCategory, breaches, trendLoggedClosed, slaByCategory, slaTrend, topRooms, byResolution,
    serviceCalls: { month: cases.filter((c) => monthKey(c.created) === curKey).length, sixMonth: cases.length },
    hcv: {
      scheduled: hcvRows.length,
      completed: hcvRows.filter((h) => h.status === "Completed").length,
      inProgress: hcvRows.filter((h) => h.status === "In Progress").length,
      outstanding: hcvRows.filter((h) => h.status === "Scheduled").length,
      rows: hcvRows.slice(0, 12),
    },
    improvements: [],
  };
}

/* ------------------------------------------------------------ sample data */
function buildSampleReport() {
  const months = last6Months();
  const ENG = ["David T", "Sam R", "Priya N"];
  const rooms = ["Leeds - Ryder", "Birmingham - Snow Hill", "London - Finsbury", "Manchester - Hardman", "Bristol - Glass Wharf", "Leeds - Boardroom"];
  const res = ["Re-Configuration", "Hardware Replacement", "Re-Cabling", "No Fault Found", "HCV Completed", "Consumable"];
  const cases = [];
  months.forEach((m, mi) => {
    const n = 8 + (mi % 3) + (mi === 5 ? 2 : 0);
    for (let i = 0; i < n; i++) {
      const fault = i % 7 === 0 ? "Room Down" : i % 2 ? "Partial Fault" : "Routine";
      const [y, mo] = m.key.split("-");
      const created = new Date(+y, +mo - 1, 2 + (i * 2) % 25, 9 + (i % 8));
      const open = mi === 5 && i % 6 === 0;
      const target = fault === "Room Down" ? 4 : fault === "Partial Fault" ? 24 : 40;
      const over = i % 6 === 0;
      const resH = over ? target * 1.4 : target * (0.3 + (i % 4) * 0.15);
      cases.push({
        title: "Sample case", fault, status: open ? "Open" : "Closed",
        created: created.toISOString(),
        closed: open ? null : new Date(created.getTime() + resH * 36e5).toISOString(),
        room: rooms[(mi + i) % rooms.length], resolution: open ? null : res[i % res.length],
        engineer: ENG[i % ENG.length],
      });
    }
  });
  const hcvRows = rooms.map((r, i) => ({
    ref: `HCV-${String(i + 1).padStart(4, "0")}`, room: r,
    status: i % 3 === 0 ? "Scheduled" : i % 4 === 0 ? "In Progress" : "Completed",
    scheduled: new Date(new Date().getFullYear(), (i * 2) % 11, 10).toISOString(),
    completed: i % 3 === 0 ? null : new Date(new Date().getFullYear(), (i * 2) % 11, 11).toISOString(),
    notes: i % 3 === 0 ? "Awaiting site access" : "",
  }));
  const report = computeMetrics(cases, hcvRows);
  report.kpis.phoneCalls = 23;
  report.improvements = [
    { desc: "Roll out QR asset tagging across Leeds rooms", owner: "David T", priority: "High", status: "In Progress", target: "Next month", next: "London next" },
    { desc: "Standardise EDID profiles on DTP switchers", owner: "Sam R", priority: "Medium", status: "Completed", target: "Done", next: "—" },
  ];
  report.meta.mode = "sample";
  report.meta.connection = null;
  return report;
}

/* ----------------------------------------------------------------- routes */
app.get("/api/report", async (req, res) => {
  try {
    if (!SC_TOKEN) return res.json(buildSampleReport());
    const report = await buildLiveReport();
    res.json(report);
  } catch (err) {
    res.json({ error: err.message, fallback: buildSampleReport() });
  }
});

app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => {
  console.log(`AV SLA dashboard running on port ${PORT} — ${SC_TOKEN ? "LIVE (token set)" : "SAMPLE DATA (no token)"}`);
});
