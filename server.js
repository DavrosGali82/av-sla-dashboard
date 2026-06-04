import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const SC_TOKEN = process.env.SC_API_TOKEN || "";
const SC_BASE = "https://api.safetyculture.io";

/* =====================================================================
   CONFIG — edit this block to match your SafetyCulture setup
   ===================================================================== */
const CONFIG = {
  companyName: "Grant Thornton UK",
  reportStartDate: "2026-05-08T00:00:00Z",

  // SLA KPI targets (TECHPR-0510 Rev 6 confirmed)
  targets: {
    "Room Down":    8,   // onsite response, business hours
    "Partial Fault":24,  // same business day (no contractual target; use 24h for reporting)
    Routine:        120, // 5 working days
  },

  // Email / phone response targets (for display)
  responseTargets: {
    email:     4,   // hours
    telephone: 1,   // hours
    hcReport:  120, // 5 working days in hours
  },

  // Call-out allocation per office per year (SLA s.7: 28/yr per office)
  callOutAllocation: 28,

  // Known offices — used to group cases by site and track call-out usage
  offices: [
    "Birmingham","Bristol","Cambridge","Cardiff","Colchester",
    "Edinburgh","Gatwick","Glasgow","Leeds","Leicester",
    "Liverpool","Manchester","Milton Keynes","Oxford",
    "Reading","Sheffield","Southampton",
  ],

  // Tags that set fault category
  faultTags: {
    "room down":    "Room Down",
    "partial fault":"Partial Fault",
    "routine":      "Routine",
  },

  // Tags that set resolution type
  resolutionTags: [
    "re-cabling","recabling","re-configuration","reconfiguration",
    "no fault found","consumable","hardware replacement",
    "referred to projects","hcv completed",
  ],

  // Priority field fallback: High→Room Down etc.
  priorityToCategory: {
    high: "Room Down", medium: "Partial Fault", low: "Routine",
  },

  closedStatuses: ["complete","completed","closed","done","resolved"],
  healthCheckTemplateId: "template_58624410208f4025b0757d47d04008d1",
  serviceCallTemplateId: "template_320444bff169480eb03b995c615b70d4",
};

/* ---------------------------------------------------------------- utils */
const hrsB = (a, b) => (new Date(b) - new Date(a)) / 36e5;
const mKey = (d) => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth()+1).padStart(2,"0")}`; };
const FAULTS = ["Room Down","Partial Fault","Routine"];
const RESOLUTIONS = ["Re-Cabling","Re-Configuration","Hardware Replacement","No Fault Found","HCV Completed","Consumable","Referred to Projects"];

function last6Months() {
  const out = [];
  for (let i = 5; i >= 0; i--) {
    const m = new Date(new Date().getFullYear(), new Date().getMonth() - i, 1);
    out.push({ key: mKey(m), label: m.toLocaleDateString("en-GB",{month:"short",year:"2-digit"}) });
  }
  return out;
}

/* ---------------------------------------------------------------- tags */
function getTags(a) {
  const candidates = [a.labels, a.label_names, a.action_labels, a.tags, a.action_label, a.label, a.tag_names];
  for (const c of candidates) {
    if (Array.isArray(c) && c.length)
      return c.map(t => (typeof t==="object" ? (t.name||t.label||t.title||"") : String(t)).toLowerCase().trim()).filter(Boolean);
    if (typeof c === "string" && c.trim())
      return c.toLowerCase().split(",").map(s=>s.trim()).filter(Boolean);
  }
  return [];
}

function classify(tags, priorityRaw) {
  let fault = null, resolution = null;
  for (const tag of tags) {
    if (!fault) for (const [k,v] of Object.entries(CONFIG.faultTags)) { if (tag.includes(k)) { fault=v; break; } }
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

// Match a SC site name to a known office
function matchOffice(siteName) {
  if (!siteName) return "Other";
  const s = siteName.toLowerCase();
  for (const o of CONFIG.offices) { if (s.includes(o.toLowerCase())) return o; }
  return siteName; // return as-is if no match
}

/* ---------------------------------------------------------------- SC pull */
async function pullFeed(path) {
  const headers = { Authorization:`Bearer ${SC_TOKEN}`, Accept:"application/json" };
  let url = `${SC_BASE}${path}`, rows = [], guard = 0;
  while (url && guard < 200) {
    guard++;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`SC ${path} → ${res.status} ${res.statusText}`);
    const j = await res.json();
    if (Array.isArray(j.data)) rows.push(...j.data);
    const next = j.metadata?.next_page;
    url = next ? `${SC_BASE}${next}` : null;
  }
  return rows;
}

function pick(o, keys) { for (const k of keys) if (o[k]!=null && o[k]!=="") return o[k]; return null; }

/* ---------------------------------------------------------------- live */
async function buildLiveReport() {
  const [actions, inspections, sites] = await Promise.all([
    pullFeed("/feed/actions"),
    pullFeed("/feed/inspections").catch(()=>[]),
    pullFeed("/feed/sites").catch(()=>[]),
  ]);

  const siteName = {};
  for (const s of sites) siteName[pick(s,["id","site_id"])] = pick(s,["name","site_name"]) || "—";

  const diagnostics = { prioritiesFound:new Set(), statusesFound:new Set(), tagsFound:new Set(), templatesFound:new Set() };
  const start = new Date(CONFIG.reportStartDate);

  const cases = actions
    .filter(a => { const c=pick(a,["created_at","created"]); return c && new Date(c)>=start; })
    .map(a => {
      const pRaw = String(pick(a,["priority","priority_label","priority_name"])||"").toLowerCase();
      const sRaw = String(pick(a,["status","status_label","status_name"])||"").toLowerCase();
      diagnostics.prioritiesFound.add(pRaw||"(blank)");
      diagnostics.statusesFound.add(sRaw||"(blank)");
      const tags = getTags(a);
      tags.forEach(t=>diagnostics.tagsFound.add(t));
      const { fault, resolution } = classify(tags, pRaw);
      const created  = pick(a,["created_at","created"]);
      const completed= pick(a,["completed_at","resolved_at"]);
      const modified = pick(a,["modified_at","updated_at"]);
      const isClosed = CONFIG.closedStatuses.includes(sRaw)||!!completed;
      const siteId   = pick(a,["site_id","site"]);
      const room     = siteName[siteId]||"—";
      return { title:pick(a,["title"])||"Action", fault, resolution, status:isClosed?"Closed":"Open",
               created, closed:isClosed?(completed||modified):null, room, office:matchOffice(room), tags };
    }).filter(c=>c.created);

  inspections.forEach(i=>{ const t=pick(i,["template_id","templateId"]); if(t) diagnostics.templatesFound.add(t); });

  const hcvRows = inspections
    .filter(i=>pick(i,["template_id","templateId"])===CONFIG.healthCheckTemplateId)
    .filter(i=>{ const d=new Date(pick(i,["date_completed","completed_at","date_started","created_at"])); return d>=start; })
    .map(i=>({
      ref:(pick(i,["audit_id","inspection_id","id"])||"").toString().slice(-8),
      room:siteName[pick(i,["site_id","site"])]||"—",
      status:pick(i,["date_completed","completed_at"])?"Completed":"In Progress",
      scheduled:pick(i,["created_at","date_started"]),
      completed:pick(i,["date_completed","completed_at"]),
      notes:"",
    }));

  const report = computeMetrics(cases, hcvRows);
  report.meta.mode = "live";
  report.meta.connection = {
    actionsPulled:    actions.length,
    inspectionsPulled:inspections.length,
    prioritiesFound:  [...diagnostics.prioritiesFound],
    statusesFound:    [...diagnostics.statusesFound],
    tagsFound:        [...diagnostics.tagsFound].slice(0,20),
    templatesFound:   [...diagnostics.templatesFound].slice(0,10),
  };
  return report;
}

/* ---------------------------------------------------------------- metrics */
function computeMetrics(cases, hcvRows) {
  const months = last6Months();
  const curKey = months[months.length-1].key;
  const t = CONFIG.targets;
  const closed = cases.filter(c=>c.status==="Closed"&&c.closed);
  const open   = cases.filter(c=>c.status==="Open");

  // ── Trends
  const trendLoggedClosed = months.map(m=>({
    month: m.label,
    logged: cases.filter(c=>mKey(c.created)===m.key).length,
    closed: closed.filter(c=>mKey(c.closed)===m.key).length,
  }));

  // ── SLA by category
  const slaByCategory = FAULTS.map(f=>{
    const cc = closed.filter(c=>c.fault===f);
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

  // Breached cases — closed over target
  const breachedCases = closed
    .filter(c=>hrsB(c.created,c.closed)>t[c.fault])
    .map(c=>({ title:c.title, fault:c.fault, room:c.room, office:c.office,
               hrs:+hrsB(c.created,c.closed).toFixed(1), target:t[c.fault],
               over:+(hrsB(c.created,c.closed)-t[c.fault]).toFixed(1),
               closed:c.closed }))
    .sort((a,b)=>b.over-a.over).slice(0,20);

  // ── Room analysis
  const roomCount = {};
  closed.forEach(c=>{ roomCount[c.room]=(roomCount[c.room]||0)+1; });
  const topRooms = Object.entries(roomCount).sort((a,b)=>b[1]-a[1]).slice(0,7).map(([name,value])=>({name,value}));

  // Room trend — top 5 rooms over 6 months
  const topRoomNames = topRooms.slice(0,5).map(r=>r.name);
  const roomTrend = months.map(m=>{
    const row = { month:m.label };
    topRoomNames.forEach(r=>{ row[r]=closed.filter(c=>c.room===r&&mKey(c.closed)===m.key).length; });
    return row;
  });

  // ── Resolution analysis
  const resCount = {};
  closed.forEach(c=>{ const r=c.resolution||"Not recorded"; resCount[r]=(resCount[r]||0)+1; });
  const byResolution = Object.entries(resCount).sort((a,b)=>b[1]-a[1]).map(([name,value])=>({name,value}));

  // Resolution trend over 6 months
  const topResNames = byResolution.slice(0,5).map(r=>r.name);
  const resTrend = months.map(m=>{
    const row = { month:m.label };
    topResNames.forEach(r=>{ row[r]=closed.filter(c=>(c.resolution||"Not recorded")===r&&mKey(c.closed)===m.key).length; });
    return row;
  });

  // ── Office allocations
  const officeUsage = {};
  cases.forEach(c=>{ officeUsage[c.office]=(officeUsage[c.office]||0)+1; });
  const allOffices = new Set([...CONFIG.offices, ...Object.keys(officeUsage)]);
  const officeAllocations = [...allOffices].map(o=>{
    const used = officeUsage[o]||0;
    const alloc = CONFIG.callOutAllocation;
    const pct = +(used/alloc*100).toFixed(1);
    const rag = pct>=90?"red":pct>=60?"amber":"green";
    return { office:o, alloc, used, remaining:alloc-used, pct, rag };
  }).sort((a,b)=>b.pct-a.pct);

  // Case lists for modals
  const curCases   = cases.filter(c=>mKey(c.created)===curKey);
  const curClosed  = closed.filter(c=>mKey(c.closed)===curKey);
  const openCases  = open.map(c=>({ title:c.title, fault:c.fault, room:c.room, office:c.office,
    created:c.created, ageHours:Math.round(hrsB(c.created,new Date())) }));

  const openByCategory = {};
  FAULTS.forEach(f=>{ openByCategory[f]=open.filter(c=>c.fault===f).length; });
  const roomDownBreaches = open.filter(c=>c.fault==="Room Down"&&hrsB(c.created,new Date())>t["Room Down"]).length;

  return {
    meta:{ mode:"sample", generatedAt:new Date().toISOString(), company:CONFIG.companyName,
           monthsLabels:months.map(m=>m.label), slaRef:"TECHPR-0510" },
    targets: t,
    responseTargets: CONFIG.responseTargets,
    callOutAllocation: CONFIG.callOutAllocation,
    kpis:{
      loggedThisMonth:  curCases.length,
      closedThisMonth:  curClosed.length,
      openNow:          open.length,
      roomDownBreaches,
    },
    openByCategory, roomDownBreaches,
    trendLoggedClosed, slaByCategory, slaTrend,
    breachedCases,
    topRooms, topRoomNames, roomTrend,
    byResolution, topResNames, resTrend,
    serviceCalls:{
      month:    curCases.length,
      sixMonth: cases.length,
      trend:    months.map(m=>({ month:m.label, visits:cases.filter(c=>mKey(c.created)===m.key).length })),
    },
    hcv:{
      scheduled:   hcvRows.length,
      completed:   hcvRows.filter(h=>h.status==="Completed").length,
      inProgress:  hcvRows.filter(h=>h.status==="In Progress").length,
      outstanding: hcvRows.filter(h=>h.status==="Scheduled").length,
      rows:        hcvRows.slice(0,15),
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
  const res = RESOLUTIONS;
  const cases = [];
  months.forEach((m,mi)=>{
    const n = [7,10,9,7,13,3][mi]||8;
    for (let i=0;i<n;i++) {
      const fault  = i%7===0?"Room Down":i%2?"Partial Fault":"Routine";
      const [y,mo] = m.key.split("-");
      const created = new Date(+y,+mo-1,2+(i*2)%25,9+(i%8));
      const isOpen  = mi===5&&i%6===0;
      const tgt     = fault==="Room Down"?8:fault==="Partial Fault"?24:120;
      const over    = i%6===0;
      const resH    = over?tgt*2.5:tgt*(0.2+(i%4)*0.15);
      const rd = roomDefs[(mi*3+i)%roomDefs.length];
      cases.push({ title:["No display output","Camera offline","Mic not working","Screen dead","Touch panel fault","No audio","Splash screen update"][i%7],
        fault, status:isOpen?"Open":"Closed", created:created.toISOString(),
        closed:isOpen?null:new Date(created.getTime()+resH*36e5).toISOString(),
        room:rd.room, office:rd.office, resolution:isOpen?null:res[i%res.length] });
    }
  });
  const hcvRows = [
    {ref:"HCV-2025-001",room:"Event Rooms (Leeds)",status:"Completed",scheduled:"2025-09-15",completed:"2025-12-19",notes:"Annual check"},
    {ref:"HCV-2025-002",room:"Event Rooms (London)",status:"In Progress",scheduled:"2025-11-01",completed:null,notes:"Booked 09/03"},
    {ref:"HCV-2026-001",room:"Standard Rooms (Manchester)",status:"In Progress",scheduled:"2026-01-01",completed:null,notes:"Booked 13/03"},
    {ref:"HCV-2026-002",room:"Critical Rooms (Birmingham)",status:"In Progress",scheduled:"2026-02-10",completed:null,notes:"Booked 05/06"},
    {ref:"HCV-2026-003",room:"Event Rooms (Bristol)",status:"Scheduled",scheduled:"2026-02-26",completed:null,notes:"Combined visit"},
  ];
  const report = computeMetrics(cases, hcvRows);
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
