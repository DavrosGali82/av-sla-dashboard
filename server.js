import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const SC_TOKEN = process.env.SC_API_TOKEN || "";
const SC_BASE = "https://api.safetyculture.io";

/* =====================================================================
   CONFIG — the one block you may need to edit
   ===================================================================== */
const CONFIG = {
  companyName: "Grant Thornton UK",
  reportStartDate: "2026-05-08T00:00:00Z",
  targets: { "Room Down": 4, "Partial Fault": 24, Routine: 40 },

  // Tags that mean "fault category" — case-insensitive, partial match ok
  faultTags: {
    "room down":    "Room Down",
    "partial fault":"Partial Fault",
    "routine":      "Routine",
  },

  // Tags that mean "resolution type" — what was done to fix it
  resolutionTags: [
    "re-cabling", "recabling",
    "re-configuration", "reconfiguration",
    "no fault found",
    "consumable",
    "hardware replacement",
    "referred to projects",
    "hcv completed",
  ],

  // Fallback: if no fault tag found, use SC priority field
  priorityToCategory: {
    high:   "Room Down",
    medium: "Partial Fault",
    low:    "Routine",
  },

  closedStatuses: ["complete", "completed", "closed", "done", "resolved"],
  healthCheckTemplateId: "template_58624410208f4025b0757d47d04008d1",
  serviceCallTemplateId: "template_320444bff169480eb03b995c615b70d4",
};

/* ---------------------------------------------------------------- utils */
const hoursBetween = (a, b) => (new Date(b) - new Date(a)) / 36e5;
const monthKey = (d) => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth()+1).padStart(2,"0")}`; };
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

/* ----------------------------------------------------------------
   getTags — tries every possible field name SC might use for tags/labels
   Returns a lowercase string array no matter what SC sends back
---------------------------------------------------------------- */
function getTags(a) {
  const candidates = [
    a.labels, a.label_names, a.action_labels, a.tags,
    a.action_label, a.label, a.tag_names,
  ];
  for (const c of candidates) {
    if (Array.isArray(c) && c.length) {
      return c.map(t =>
        (typeof t === "object" ? (t.name || t.label || t.title || "") : String(t))
        .toLowerCase().trim()
      ).filter(Boolean);
    }
    if (typeof c === "string" && c.trim()) {
      return c.toLowerCase().split(",").map(s => s.trim()).filter(Boolean);
    }
  }
  return [];
}

/* ----------------------------------------------------------------
   From a tag list, find the fault category and resolution type
---------------------------------------------------------------- */
function classifyFromTags(tags, priorityRaw) {
  let fault = null;
  let resolution = null;

  for (const tag of tags) {
    // check fault category
    if (!fault) {
      for (const [key, val] of Object.entries(CONFIG.faultTags)) {
        if (tag.includes(key)) { fault = val; break; }
      }
    }
    // check resolution type — find closest match
    if (!resolution) {
      for (const r of CONFIG.resolutionTags) {
        if (tag.includes(r) || r.includes(tag)) {
          // normalise to title case for display
          resolution = CONFIG.resolutionTags.find(x => tag.includes(x) || x.includes(tag));
          resolution = resolution
            ? resolution.split(" ").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ")
            : null;
          break;
        }
      }
    }
  }

  // fallback to priority if no fault tag found
  if (!fault) {
    fault = CONFIG.priorityToCategory[priorityRaw.toLowerCase()] || "Routine";
  }

  return { fault, resolution };
}

/* ---------------------------------------------------------------- SC feed */
async function pullFeed(feedPath) {
  const headers = { Authorization: `Bearer ${SC_TOKEN}`, Accept: "application/json" };
  let url = `${SC_BASE}${feedPath}`;
  const rows = [];
  let guard = 0;
  while (url && guard < 200) {
    guard++;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`SC ${feedPath} → ${res.status} ${res.statusText}`);
    const json = await res.json();
    if (Array.isArray(json.data)) rows.push(...json.data);
    const next = json.metadata?.next_page;
    url = next ? `${SC_BASE}${next}` : null;
  }
  return rows;
}

function pick(obj, keys) {
  for (const k of keys) if (obj[k] != null && obj[k] !== "") return obj[k];
  return null;
}

/* ---------------------------------------------------------------- live */
async function buildLiveReport() {
  const [actions, inspections, sites] = await Promise.all([
    pullFeed("/feed/actions"),
    pullFeed("/feed/inspections").catch(() => []),
    pullFeed("/feed/sites").catch(() => []),
  ]);

  const siteName = {};
  for (const s of sites) siteName[pick(s, ["id","site_id"])] = pick(s, ["name","site_name"]) || "—";

  const prioritiesFound = new Set();
  const statusesFound   = new Set();
  const tagsFound       = new Set();
  const templatesFound  = new Set();

  const reportStart = new Date(CONFIG.reportStartDate);

  const cases = actions
    .filter(a => {
      const created = pick(a, ["created_at","created"]);
      return created && new Date(created) >= reportStart;
    })
    .map(a => {
      const priorityRaw = String(pick(a, ["priority","priority_label","priority_name"]) || "").toLowerCase();
      const statusRaw   = String(pick(a, ["status","status_label","status_name"]) || "").toLowerCase();
      prioritiesFound.add(priorityRaw || "(blank)");
      statusesFound.add(statusRaw || "(blank)");

      const tags = getTags(a);
      tags.forEach(t => tagsFound.add(t));

      const { fault, resolution } = classifyFromTags(tags, priorityRaw);

      const created   = pick(a, ["created_at","created"]);
      const completed = pick(a, ["completed_at","resolved_at"]);
      const modified  = pick(a, ["modified_at","updated_at"]);
      const isClosed  = CONFIG.closedStatuses.includes(statusRaw) || !!completed;
      const closedAt  = isClosed ? (completed || modified) : null;
      const siteId    = pick(a, ["site_id","site"]);

      return {
        title:      pick(a, ["title"]) || "Action",
        fault,
        resolution: resolution || null,
        status:     isClosed ? "Closed" : "Open",
        created,
        closed:     closedAt,
        room:       siteName[siteId] || "—",
        tags,
      };
    })
    .filter(c => c.created);

  inspections.forEach(i => {
    const t = pick(i, ["template_id","templateId"]);
    if (t) templatesFound.add(t);
  });

  const hcvRows = inspections
    .filter(i => pick(i, ["template_id","templateId"]) === CONFIG.healthCheckTemplateId)
    .filter(i => {
      const d = new Date(pick(i, ["date_completed","completed_at","date_started","created_at"]));
      return d >= reportStart;
    })
    .map(i => {
      const done = !!pick(i, ["date_completed","completed_at"]);
      const siteId = pick(i, ["site_id","site"]);
      return {
        ref:       (pick(i, ["audit_id","inspection_id","id"]) || "").toString().slice(-8),
        room:      siteName[siteId] || "—",
        status:    done ? "Completed" : "In Progress",
        scheduled: pick(i, ["created_at","date_started"]),
        completed: pick(i, ["date_completed","completed_at"]),
        notes:     "",
      };
    });

  const report = computeMetrics(cases, hcvRows);
  report.meta.mode = "live";
  report.meta.connection = {
    actionsPulled:    actions.length,
    inspectionsPulled:inspections.length,
    prioritiesFound:  [...prioritiesFound],
    statusesFound:    [...statusesFound],
    tagsFound:        [...tagsFound].slice(0, 20),
    templatesFound:   [...templatesFound].slice(0, 10),
  };
  return report;
}

/* ---------------------------------------------------------------- metrics */
function computeMetrics(cases, hcvRows) {
  const months  = last6Months();
  const curKey  = months[months.length - 1].key;
  const t       = CONFIG.targets;
  const closed  = cases.filter(c => c.status === "Closed" && c.closed);
  const open    = cases.filter(c => c.status === "Open");

  const trendLoggedClosed = months.map(m => ({
    month:  m.label,
    logged: cases.filter(c => monthKey(c.created) === m.key).length,
    closed: closed.filter(c => monthKey(c.closed) === m.key).length,
  }));

  const slaByCategory = FAULTS.map(f => {
    const cc  = closed.filter(c => c.fault === f);
    const avg = cc.length ? cc.reduce((s,c) => s + hoursBetween(c.created, c.closed), 0) / cc.length : 0;
    return { fault: f, avg: +avg.toFixed(1), target: t[f], within: cc.length ? avg <= t[f] : true };
  });

  const slaTrend = months.map(m => {
    const row = { month: m.label };
    FAULTS.forEach(f => {
      const cc = closed.filter(c => c.fault === f && monthKey(c.closed) === m.key);
      row[f] = cc.length ? +(cc.reduce((s,c) => s + hoursBetween(c.created, c.closed), 0) / cc.length).toFixed(1) : null;
    });
    return row;
  });

  const roomCount = {};
  closed.forEach(c => { roomCount[c.room] = (roomCount[c.room] || 0) + 1; });
  const topRooms = Object.entries(roomCount).sort((a,b) => b[1]-a[1]).slice(0,5).map(([name,value]) => ({name,value}));

  const resCount = {};
  closed.forEach(c => { const r = c.resolution || "Not recorded"; resCount[r] = (resCount[r]||0)+1; });
  const byResolution = Object.entries(resCount).map(([name,value]) => ({name,value}));

  const openByCategory = {};
  FAULTS.forEach(f => { openByCategory[f] = open.filter(c => c.fault === f).length; });
  const breaches = open.filter(c => c.fault === "Room Down" && hoursBetween(c.created, new Date()) > t["Room Down"]).length;

  // Case lists for interactive cards
  const loggedThisMonthCases = cases
    .filter(c => monthKey(c.created) === curKey)
    .map(c => ({ title: c.title, fault: c.fault, room: c.room, created: c.created, status: c.status }));

  const closedThisMonthCases = closed
    .filter(c => monthKey(c.closed) === curKey)
    .map(c => ({ title: c.title, fault: c.fault, room: c.room, closed: c.closed, resolution: c.resolution }));

  const openCases = open.map(c => ({
    title: c.title, fault: c.fault, room: c.room, created: c.created,
    ageHours: Math.round(hoursBetween(c.created, new Date())),
  }));

  return {
    meta: { mode: "sample", generatedAt: new Date().toISOString(), company: CONFIG.companyName, monthsLabels: months.map(m => m.label) },
    targets: t,
    kpis: {
      loggedThisMonth:  cases.filter(c => monthKey(c.created) === curKey).length,
      closedThisMonth:  closed.filter(c => monthKey(c.closed) === curKey).length,
      openNow:          open.length,
      phoneCalls:       0,
    },
    openByCategory, breaches,
    trendLoggedClosed, slaByCategory, slaTrend, topRooms, byResolution,
    serviceCalls: {
      month:    cases.filter(c => monthKey(c.created) === curKey).length,
      sixMonth: cases.length,
    },
    hcv: {
      scheduled:   hcvRows.length,
      completed:   hcvRows.filter(h => h.status === "Completed").length,
      inProgress:  hcvRows.filter(h => h.status === "In Progress").length,
      outstanding: hcvRows.filter(h => h.status === "Scheduled").length,
      rows:        hcvRows.slice(0, 12),
    },
    // case lists for clickable cards
    loggedThisMonthCases,
    closedThisMonthCases,
    openCases,
    improvements: [],
  };
}

/* ---------------------------------------------------------------- sample */
function buildSampleReport() {
  const months = last6Months();
  const rooms = ["Leeds - Ryder","Birmingham - Snow Hill","London - Finsbury","Manchester - Hardman","Bristol - Glass Wharf","Leeds - Boardroom"];
  const res   = ["Re-Configuration","Hardware Replacement","Re-Cabling","No Fault Found","HCV Completed","Consumable"];
  const cases = [];
  months.forEach((m, mi) => {
    const n = 8 + (mi % 3) + (mi === 5 ? 2 : 0);
    for (let i = 0; i < n; i++) {
      const fault  = i % 7 === 0 ? "Room Down" : i % 2 ? "Partial Fault" : "Routine";
      const [y,mo] = m.key.split("-");
      const created = new Date(+y, +mo-1, 2+(i*2)%25, 9+(i%8));
      const openCase = mi === 5 && i % 6 === 0;
      const target   = fault === "Room Down" ? 4 : fault === "Partial Fault" ? 24 : 40;
      const resH     = i % 6 === 0 ? target * 1.4 : target * (0.3 + (i%4)*0.15);
      cases.push({
        title:      ["No display output","Camera not tracking","Splash screen update","System won't power on","Mic dead","Firmware check"][i%6],
        fault,
        status:     openCase ? "Open" : "Closed",
        created:    created.toISOString(),
        closed:     openCase ? null : new Date(created.getTime() + resH*36e5).toISOString(),
        room:       rooms[(mi+i) % rooms.length],
        resolution: openCase ? null : res[i % res.length],
      });
    }
  });
  const hcvRows = rooms.map((r,i) => ({
    ref:`HCV-${String(i+1).padStart(4,"0")}`, room:r,
    status: i%3===0 ? "Scheduled" : i%4===0 ? "In Progress" : "Completed",
    scheduled: new Date(new Date().getFullYear(),(i*2)%11,10).toISOString(),
    completed: i%3===0 ? null : new Date(new Date().getFullYear(),(i*2)%11,11).toISOString(),
    notes: i%3===0 ? "Awaiting site access" : "",
  }));
  const report = computeMetrics(cases, hcvRows);
  report.kpis.phoneCalls = 23;
  report.improvements = [
    { desc:"Roll out QR asset tagging across Leeds rooms", owner:"David T", priority:"High", status:"In Progress", target:"Next month", next:"London next" },
    { desc:"Standardise EDID profiles on DTP switchers",   owner:"Sam R",   priority:"Medium", status:"Completed", target:"Done", next:"—" },
  ];
  report.meta.mode = "sample";
  report.meta.connection = null;
  return report;
}

/* ---------------------------------------------------------------- routes */
app.get("/api/report", async (req, res) => {
  try {
    if (!SC_TOKEN) return res.json(buildSampleReport());
    const report = await buildLiveReport();
    res.json(report);
  } catch (err) {
    console.error(err);
    res.json({ error: err.message, fallback: buildSampleReport() });
  }
});

app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => {
  console.log(`AV SLA dashboard on port ${PORT} — ${SC_TOKEN ? "LIVE" : "SAMPLE DATA"}`);
});
