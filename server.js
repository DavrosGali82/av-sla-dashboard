import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const SC_TOKEN = process.env.SC_API_TOKEN || "";
const SC_BASE = "https://api.safetyculture.io";

/* =====================================================================
   CONFIG
   ===================================================================== */
const CONFIG = {
  companyName: "Grant Thornton UK",
  reportStartDate: "2026-05-08T00:00:00Z",

  targets: {
    "Room Down":     8,
    "Partial Fault": 24,
    Routine:         120,
  },

  responseTargets: { email: 4, telephone: 1, hcReport: 120 },
  callOutAllocation: 28,
  visitsPerOfficePerYear: 2,

  offices: [
    "Birmingham","Bristol","Cambridge","Cardiff","Colchester",
    "Edinburgh","Gatwick","Glasgow","Leeds","Leicester",
    "Liverpool","Manchester","Milton Keynes","Oxford",
    "Reading","Sheffield","Southampton",
  ],

  faultTags: {
    "room down":    "Room Down",
    "partial fault":"Partial Fault",
    "routine":      "Routine",
  },

  resolutionTags: [
    "re-cabling","recabling","re-configuration","reconfiguration",
    "no fault found","consumable","hardware replacement",
    "referred to projects","hcv completed",
  ],

  priorityToCategory: {
    high: "Room Down", medium: "Partial Fault", low: "Routine",
  },

  closedStatuses: ["complete","completed","closed","done","resolved"],
  healthCheckTemplateId: "template_58624410208f4025b0757d47d04008d1",
  serviceCallTemplateId: "template_320444bff169480eb03b995c615b70d4",
  officeHCVTemplateId:   "template_a68b6c7b138e438f89c8706ff3b7ea37",
};

/* ---------------------------------------------------------------- utils */
const hrsB  = (a, b) => (new Date(b) - new Date(a)) / 36e5;
const mKey  = (d) => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth()+1).padStart(2,"0")}`; };
const FAULTS     = ["Room Down","Partial Fault","Routine"];
const RESOLUTIONS = ["Re-Cabling","Re-Configuration","Hardware Replacement","No Fault Found","HCV Completed","Consumable","Referred to Projects"];
const now = () => new Date();

function last6Months() {
  const out = [];
  for (let i = 5; i >= 0; i--) {
    const m = new Date(now().getFullYear(), now().getMonth() - i, 1);
    out.push({ key: mKey(m), label: m.toLocaleDateString("en-GB",{month:"short",year:"2-digit"}) });
  }
  return out;
}

/* ---------------------------------------------------------------- tags */
function getTags(a) {
  const candidates = [a.labels, a.label_names, a.action_labels, a.tags, a.action_label, a.label, a.tag_names];
  for (const c of candidates) {
    if (Array.isArray(c) && c.length)
      return c.map(t=>(typeof t==="object"?(t.name||t.label||t.title||""):String(t)).toLowerCase().trim()).filter(Boolean);
    if (typeof c === "string" && c.trim())
      return c.toLowerCase().split(",").map(s=>s.trim()).filter(Boolean);
  }
  return [];
}

function classify(tags, priorityRaw) {
  let fault = null, resolution = null;
  for (const tag of tags) {
    if (!fault)      for (const [k,v] of Object.entries(CONFIG.faultTags))  { if (tag.includes(k)) { fault=v; break; } }
    if (!resolution) for (const r of CONFIG.resolutionTags) {
      if (tag.includes(r) || r.includes(tag)) {
        resolution = r.split(" ").map(w=>w.charAt(0).toUpperCase()+w.slice(1)).join(" ");
        break;
      }
    }
  }
  if (!fault) fault = CONFIG.priorityToCategory[priorityRaw.toLowerCase()] || "Routine";
  return { fault, resolution };
}

function matchOffice(siteName) {
  if (!siteName) return "Other";
  const s = siteName.toLowerCase();
  for (const o of CONFIG.offices) { if (s.includes(o.toLowerCase())) return o; }
  return siteName;
}

/* ---------------------------------------------------------------- SC helpers */
function pick(o, keys) {
  for (const k of keys) if (o[k]!=null && o[k]!=="") return o[k];
  return null;
}

async function pullFeed(feedPath) {
  const headers = { Authorization:`Bearer ${SC_TOKEN}`, Accept:"application/json" };
  let url = `${SC_BASE}${feedPath}`, rows = [], guard = 0;
  while (url && guard < 200) {
    guard++;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`SC ${feedPath} → ${res.status} ${res.statusText}`);
    const j = await res.json();
    if (Array.isArray(j.data)) rows.push(...j.data);
    url = j.metadata?.next_page ? `${SC_BASE}${j.metadata.next_page}` : null;
  }
  return rows;
}

// Fetch full inspection details to read question responses
async function fetchInspectionDetails(inspectionId) {
  try {
    const res = await fetch(
      `${SC_BASE}/inspections/v1/inspections/${inspectionId}/details`,
      { headers: { Authorization:`Bearer ${SC_TOKEN}`, Accept:"application/json" } }
    );
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

// Read a response value from inspection details by matching question label
// SC details items can be nested; we walk the whole tree
function getFieldResponse(details, labelKeyword) {
  if (!details) return null;
  const keyword = labelKeyword.toLowerCase();

  function walk(items) {
    if (!Array.isArray(items)) return null;
    for (const item of items) {
      const label = (item.label || item.item?.label || "").toLowerCase();
      if (label.includes(keyword)) {
        const r = item.responses || item.response || {};
        // Date/datetime fields
        if (r.datetime) return r.datetime;
        if (r.date)     return r.date;
        // Dropdown / multiple choice
        if (Array.isArray(r.selected) && r.selected.length)
          return r.selected[0]?.label || String(r.selected[0]);
        if (r.selected?.label) return r.selected.label;
        // Text / number
        if (r.text)  return r.text;
        if (r.value != null) return String(r.value);
      }
      // Recurse into child items
      const found = walk(item.items || item.children || []);
      if (found) return found;
    }
    return null;
  }

  const items = details.items || details.audit?.items || details.pages?.flatMap(p=>p.items||[]) || [];
  return walk(items);
}

/* ---------------------------------------------------------------- live */
async function buildLiveReport() {
  const [actions, inspections, sites] = await Promise.all([
    pullFeed("/feed/actions"),
    pullFeed("/feed/inspections").catch(()=>[]),
    pullFeed("/feed/sites").catch(()=>[]),
  ]);

  const siteName = {};
  for (const s of sites) siteName[pick(s,["id","site_id"])] = pick(s,["name","site_name"]) || "—";

  const diag = { prioritiesFound:new Set(), statusesFound:new Set(), tagsFound:new Set(), templatesFound:new Set() };
  const start = new Date(CONFIG.reportStartDate);

  // ── Cases from actions
  const cases = actions
    .filter(a => { const c=pick(a,["created_at","created"]); return c && new Date(c)>=start; })
    .map(a => {
      const pRaw = String(pick(a,["priority","priority_label","priority_name"])||"").toLowerCase();
      const sRaw = String(pick(a,["status","status_label","status_name"])||"").toLowerCase();
      diag.prioritiesFound.add(pRaw||"(blank)");
      diag.statusesFound.add(sRaw||"(blank)");
      const tags = getTags(a);
      tags.forEach(t=>diag.tagsFound.add(t));
      const { fault, resolution } = classify(tags, pRaw);
      const created  = pick(a,["created_at","created"]);
      const completed= pick(a,["completed_at","resolved_at"]);
      const modified = pick(a,["modified_at","updated_at"]);
      const isClosed = CONFIG.closedStatuses.includes(sRaw)||!!completed;
      const siteId   = pick(a,["site_id","site"]);
      const room     = siteName[siteId]||"—";
      return { title:pick(a,["title"])||"Action", fault, resolution,
               status:isClosed?"Closed":"Open", created,
               closed:isClosed?(completed||modified):null,
               room, office:matchOffice(room), tags };
    }).filter(c=>c.created);

  inspections.forEach(i=>{ const t=pick(i,["template_id","templateId"]); if(t) diag.templatesFound.add(t); });

  // ── Room-level HCV (existing template — detailed inspection records)
  const hcvRows = inspections
    .filter(i=>pick(i,["template_id","templateId"])===CONFIG.healthCheckTemplateId)
    .filter(i=>{ const d=new Date(pick(i,["date_completed","completed_at","date_started","created_at"])); return d>=start; })
    .map(i=>({
      ref:      (pick(i,["audit_id","inspection_id","id"])||"").toString().slice(-8),
      room:     siteName[pick(i,["site_id","site"])]||"—",
      status:   pick(i,["date_completed","completed_at"])?"Completed":"In Progress",
      scheduled:pick(i,["created_at","date_started"]),
      completed:pick(i,["date_completed","completed_at"]),
      notes:"",
    }));

  // ── Office HCV summary (new template — one record per office visit)
  const officeHCVInspections = inspections
    .filter(i=>pick(i,["template_id","templateId"])===CONFIG.officeHCVTemplateId);

  // Fetch full details for each so we can read the Scheduled Date field
  const officeHCVRaw = await Promise.all(
    officeHCVInspections.map(async i => {
      const id      = String(pick(i,["audit_id","inspection_id","id"])||"");
      const details = await fetchInspectionDetails(id);
      const siteId  = pick(i,["site_id","site"]);
      const siteLbl = siteName[siteId]||"—";
      const office  = matchOffice(siteLbl);

      // Read question responses
      const scheduledRaw = getFieldResponse(details, "scheduled");
      const visitNumRaw  = getFieldResponse(details, "visit");
      const outcome      = getFieldResponse(details, "outcome") || getFieldResponse(details, "overall") || "—";

      const completed   = pick(i,["date_completed","completed_at"]);
      const isCompleted = !!completed;
      const scheduledDate = scheduledRaw ? new Date(scheduledRaw) : null;

      // Status logic:
      // Completed  — has a completion date
      // Overdue    — no completion, scheduled date has passed
      // Booked     — no completion, scheduled date is in the future
      // In progress— no completion, no scheduled date (inspection started but not dated)
      let status;
      if      (isCompleted)                              status = "Completed";
      else if (scheduledDate && scheduledDate < now())   status = "Overdue";
      else if (scheduledDate && scheduledDate >= now())  status = "Booked";
      else                                               status = "In Progress";

      const visitNum = visitNumRaw && visitNumRaw.includes("2") ? 2 : 1;

      return { id, office, visitNum, status, scheduled:scheduledRaw||null, completed:completed||null, outcome, siteName:siteLbl };
    })
  );

  // Build per-office summary — one row per office, two visit slots each
  const officeHCVSummary = CONFIG.offices.map(o => {
    const visits = officeHCVRaw.filter(h=>h.office===o);
    const v1 = visits.find(h=>h.visitNum===1) || null;
    const v2 = visits.find(h=>h.visitNum===2) || null;
    return {
      office: o,
      visit1: v1 ? { status:v1.status, scheduled:v1.scheduled, completed:v1.completed, outcome:v1.outcome } : { status:"Not scheduled", scheduled:null, completed:null, outcome:null },
      visit2: v2 ? { status:v2.status, scheduled:v2.scheduled, completed:v2.completed, outcome:v2.outcome } : { status:"Not scheduled", scheduled:null, completed:null, outcome:null },
    };
  });

  const report = computeMetrics(cases, hcvRows, officeHCVSummary);
  report.meta.mode = "live";
  report.meta.connection = {
    actionsPulled:     actions.length,
    inspectionsPulled: inspections.length,
    officeHCVPulled:   officeHCVInspections.length,
    prioritiesFound:   [...diag.prioritiesFound],
    statusesFound:     [...diag.statusesFound],
    tagsFound:         [...diag.tagsFound].slice(0,20),
    templatesFound:    [...diag.templatesFound].slice(0,10),
  };
  return report;
}

/* ---------------------------------------------------------------- metrics */
function computeMetrics(cases, hcvRows, officeHCVSummary = []) {
  const months   = last6Months();
  const curKey   = months[months.length-1].key;
  const t        = CONFIG.targets;
  const closed   = cases.filter(c=>c.status==="Closed"&&c.closed);
  const open     = cases.filter(c=>c.status==="Open");

  const trendLoggedClosed = months.map(m=>({
    month:  m.label,
    logged: cases.filter(c=>mKey(c.created)===m.key).length,
    closed: closed.filter(c=>mKey(c.closed)===m.key).length,
  }));

  const slaByCategory = FAULTS.map(f=>{
    const cc  = closed.filter(c=>c.fault===f);
    const avg = cc.length ? cc.reduce((s,c)=>s+hrsB(c.created,c.closed),0)/cc.length : 0;
    return { fault:f, avg:+avg.toFixed(1), target:t[f], within:cc.length?avg<=t[f]:true, count:cc.length };
  });

  const slaTrend = months.map(m=>{
    const row = { month:m.label };
    FAULTS.forEach(f=>{
      const cc = closed.filter(c=>c.fault===f&&mKey(c.closed)===m.key);
      row[f] = cc.length ? +(cc.reduce((s,c)=>s+hrsB(c.created,c.closed),0)/cc.length).toFixed(1) : null;
    });
    return row;
  });

  const breachedCases = closed
    .filter(c=>hrsB(c.created,c.closed)>t[c.fault])
    .map(c=>({ title:c.title, fault:c.fault, room:c.room, office:c.office,
               hrs:+hrsB(c.created,c.closed).toFixed(1), target:t[c.fault],
               over:+(hrsB(c.created,c.closed)-t[c.fault]).toFixed(1), closed:c.closed }))
    .sort((a,b)=>b.over-a.over).slice(0,20);

  const roomCount = {};
  closed.forEach(c=>{ roomCount[c.room]=(roomCount[c.room]||0)+1; });
  const topRooms      = Object.entries(roomCount).sort((a,b)=>b[1]-a[1]).slice(0,7).map(([name,value])=>({name,value}));
  const topRoomNames  = topRooms.slice(0,5).map(r=>r.name);
  const roomTrend     = months.map(m=>{ const row={month:m.label}; topRoomNames.forEach(r=>{ row[r]=closed.filter(c=>c.room===r&&mKey(c.closed)===m.key).length; }); return row; });

  const resCount = {};
  closed.forEach(c=>{ const r=c.resolution||"Not recorded"; resCount[r]=(resCount[r]||0)+1; });
  const byResolution  = Object.entries(resCount).sort((a,b)=>b[1]-a[1]).map(([name,value])=>({name,value}));
  const topResNames   = byResolution.slice(0,5).map(r=>r.name);
  const resTrend      = months.map(m=>{ const row={month:m.label}; topResNames.forEach(r=>{ row[r]=closed.filter(c=>(c.resolution||"Not recorded")===r&&mKey(c.closed)===m.key).length; }); return row; });

  const officeUsage = {};
  cases.forEach(c=>{ officeUsage[c.office]=(officeUsage[c.office]||0)+1; });
  const allOffices = new Set([...CONFIG.offices,...Object.keys(officeUsage)]);
  const officeAllocations = [...allOffices].map(o=>{
    const used=officeUsage[o]||0, alloc=CONFIG.callOutAllocation;
    const pct=+(used/alloc*100).toFixed(1);
    return { office:o, alloc, used, remaining:alloc-used, pct, rag:pct>=90?"red":pct>=60?"amber":"green" };
  }).sort((a,b)=>b.pct-a.pct);

  const curCases  = cases.filter(c=>mKey(c.created)===curKey);
  const curClosed = closed.filter(c=>mKey(c.closed)===curKey);
  const openCases = open.map(c=>({ title:c.title, fault:c.fault, room:c.room, office:c.office,
    created:c.created, ageHours:Math.round(hrsB(c.created,now())) }));

  const openByCategory = {};
  FAULTS.forEach(f=>{ openByCategory[f]=open.filter(c=>c.fault===f).length; });
  const roomDownBreaches = open.filter(c=>c.fault==="Room Down"&&hrsB(c.created,now())>t["Room Down"]).length;

  // Office HCV headline counts
  const expectedTotal   = CONFIG.offices.length * CONFIG.visitsPerOfficePerYear;
  const allVisitSlots   = officeHCVSummary.flatMap(o=>[o.visit1,o.visit2]);
  const hcvCompleted    = allVisitSlots.filter(v=>v.status==="Completed").length;
  const hcvBooked       = allVisitSlots.filter(v=>v.status==="Booked").length;
  const hcvOverdue      = allVisitSlots.filter(v=>v.status==="Overdue").length;
  const hcvNotScheduled = allVisitSlots.filter(v=>v.status==="Not scheduled").length;

  return {
    meta:{ mode:"sample", generatedAt:now().toISOString(), company:CONFIG.companyName,
           monthsLabels:months.map(m=>m.label), slaRef:"TECHPR-0510" },
    targets:t, responseTargets:CONFIG.responseTargets, callOutAllocation:CONFIG.callOutAllocation,
    kpis:{ loggedThisMonth:curCases.length, closedThisMonth:curClosed.length, openNow:open.length, roomDownBreaches },
    openByCategory, roomDownBreaches,
    trendLoggedClosed, slaByCategory, slaTrend, breachedCases,
    topRooms, topRoomNames, roomTrend, byResolution, topResNames, resTrend,
    serviceCalls:{ month:curCases.length, sixMonth:cases.length,
      trend:months.map(m=>({ month:m.label, visits:cases.filter(c=>mKey(c.created)===m.key).length })) },
    hcv:{ // room-level detail (existing template)
      scheduled:hcvRows.length, completed:hcvRows.filter(h=>h.status==="Completed").length,
      inProgress:hcvRows.filter(h=>h.status==="In Progress").length,
      outstanding:hcvRows.filter(h=>h.status==="Scheduled").length,
      rows:hcvRows.slice(0,15),
    },
    officeHCV:{ // office-level summary (new template)
      expected:     expectedTotal,
      completed:    hcvCompleted,
      booked:       hcvBooked,
      overdue:      hcvOverdue,
      notScheduled: hcvNotScheduled,
      summary:      officeHCVSummary,
    },
    officeAllocations,
    loggedThisMonthCases: curCases.map(c=>({title:c.title,fault:c.fault,room:c.room,created:c.created,status:c.status})),
    closedThisMonthCases: curClosed.map(c=>({title:c.title,fault:c.fault,room:c.room,closed:c.closed,resolution:c.resolution})),
    openCases,
    improvements:[],
  };
}

/* ---------------------------------------------------------------- sample */
function buildSampleReport() {
  const months = last6Months();
  const roomDefs = [
    {room:"801 - Event Space",office:"Leeds"},
    {room:"106/107/108 (Divisible)",office:"Leeds"},
    {room:"LG01/LG02",office:"London"},
    {room:"Critical Rooms",office:"Birmingham"},
    {room:"118",office:"Manchester"},
    {room:"Boardroom A",office:"Bristol"},
    {room:"Conference Suite",office:"Glasgow"},
  ];
  const cases = [];
  months.forEach((m,mi)=>{
    const n=[7,10,9,7,13,3][mi]||8;
    for (let i=0;i<n;i++) {
      const fault=i%7===0?"Room Down":i%2?"Partial Fault":"Routine";
      const [y,mo]=m.key.split("-");
      const created=new Date(+y,+mo-1,2+(i*2)%25,9+(i%8));
      const isOpen=mi===5&&i%6===0;
      const tgt=fault==="Room Down"?8:fault==="Partial Fault"?24:120;
      const resH=i%6===0?tgt*2.5:tgt*(0.2+(i%4)*0.15);
      const rd=roomDefs[(mi*3+i)%roomDefs.length];
      cases.push({ title:["No display output","Camera offline","Mic not working","Screen dead","Touch panel fault","No audio","Splash screen update"][i%7],
        fault, status:isOpen?"Open":"Closed", created:created.toISOString(),
        closed:isOpen?null:new Date(created.getTime()+resH*36e5).toISOString(),
        room:rd.room, office:rd.office, resolution:isOpen?null:RESOLUTIONS[i%RESOLUTIONS.length] });
    }
  });

  const hcvRows = [
    {ref:"HCV-001",room:"Event Rooms (Leeds)",      status:"Completed",  scheduled:"2025-09-15",completed:"2025-12-19",notes:""},
    {ref:"HCV-002",room:"Event Rooms (London)",     status:"In Progress",scheduled:"2025-11-01",completed:null,        notes:"Booked 09/03"},
    {ref:"HCV-003",room:"Rooms (Manchester)",       status:"In Progress",scheduled:"2026-01-01",completed:null,        notes:"Booked 13/03"},
  ];

  // Sample office HCV summary — shows a mix of statuses for the demo
  const sampleStatuses = [
    ["Completed","Booked"],["Booked","Not scheduled"],["Not scheduled","Not scheduled"],
    ["Completed","Completed"],["Overdue","Not scheduled"],["Booked","Not scheduled"],
    ["Not scheduled","Not scheduled"],["Completed","Booked"],["Overdue","Booked"],
    ["Not scheduled","Not scheduled"],["Booked","Not scheduled"],["Completed","Not scheduled"],
    ["Not scheduled","Not scheduled"],["Booked","Not scheduled"],["Completed","Booked"],
    ["Overdue","Not scheduled"],["Not scheduled","Not scheduled"],
  ];
  const mkDate = (daysFromNow) => new Date(now().getTime()+daysFromNow*864e5).toISOString();
  const officeHCVSummary = CONFIG.offices.map((o,i)=>{
    const [s1,s2] = sampleStatuses[i]||["Not scheduled","Not scheduled"];
    const mkVisit = (s) => ({
      status:s,
      scheduled: s==="Not scheduled"?null: s==="Completed"?mkDate(-60): s==="Overdue"?mkDate(-5):mkDate(30),
      completed: s==="Completed"?mkDate(-45):null,
      outcome:   s==="Completed"?(i%3===0?"Minor Issues":"All Good"):null,
    });
    return { office:o, visit1:mkVisit(s1), visit2:mkVisit(s2) };
  });

  const report = computeMetrics(cases, hcvRows, officeHCVSummary);
  report.meta.mode = "sample";
  report.meta.connection = null;
  report.improvements = [
    {desc:"Implement monthly engineer pre-brief",category:"Process",owner:"David T",raised:"2026-01-01",target:"2026-03-31",closed:null,priority:"High",status:"In Progress",progress:"Template drafted",next:"Review March"},
    {desc:"Update room asset register — all London offices",category:"Asset Management",owner:"David T",raised:"2026-01-15",target:"2026-04-30",closed:null,priority:"Medium",status:"Open",progress:"",next:"Assign lead"},
    {desc:"Real-time SLA dashboard for client",category:"Reporting",owner:"David T",raised:"2026-02-01",target:"2026-06-30",closed:null,priority:"High",status:"In Progress",progress:"Dashboard live in Render",next:"Share link with Danni"},
  ];
  return report;
}

/* ---------------------------------------------------------------- routes */
app.get("/api/report", async (req,res)=>{
  try {
    if (!SC_TOKEN) return res.json(buildSampleReport());
    res.json(await buildLiveReport());
  } catch(err) {
    console.error(err);
    res.json({ error:err.message, fallback:buildSampleReport() });
  }
});

app.use(express.static(path.join(__dirname,"public")));
app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));

app.listen(PORT,()=>console.log(`AV Dashboard on port ${PORT} — ${SC_TOKEN?"LIVE":"SAMPLE DATA"}`));
