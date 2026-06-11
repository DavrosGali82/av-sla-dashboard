import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { readFileSync, writeFileSync, existsSync } from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const SC_TOKEN = process.env.SC_API_TOKEN || "";
const SC_BASE = "https://api.safetyculture.io";

/* ── Improvements store ── */
const IMPROVEMENTS_FILE = path.join(__dirname, "data", "improvements.json");
function loadImprovements() {
  try { if (existsSync(IMPROVEMENTS_FILE)) return JSON.parse(readFileSync(IMPROVEMENTS_FILE, "utf8")); } catch {}
  return [];
}
function saveImprovements(data) {
  try { writeFileSync(IMPROVEMENTS_FILE, JSON.stringify(data, null, 2)); } catch {}
}
let improvements = loadImprovements();

/* ── UK Bank Holidays ── */
let bankHolidays = new Set();
let bhLoaded = false;
async function loadBankHolidays() {
  if (bhLoaded) return;
  try {
    const r = await fetch("https://www.gov.uk/bank-holidays.json");
    const j = await r.json();
    (j["england-and-wales"]?.events || []).forEach(e => bankHolidays.add(e.date));
    bhLoaded = true;
  } catch {}
}

/* =====================================================================
   CONFIG
   ===================================================================== */
const CONFIG = {
  companyName: "Grant Thornton UK",
  reportStartDate: "2026-05-08T00:00:00Z",
  targets: { "Room Down": 8, "Partial Fault": 24, Routine: 120 },
  responseTargets: { email: 4, telephone: 1, hcReport: 120 },
  workdayStart: 8, workdayEnd: 18,
  visitsPerOfficePerYear: 2, // default fallback only
  hcvVisits: {
    Birmingham:2, Bristol:1, Cambridge:2, Cardiff:1, Colchester:1,
    Edinburgh:2, Gatwick:1, Glasgow:2, Leeds:2, Leicester:2,
    Liverpool:2, Manchester:2, "Milton Keynes":1, Oxford:2,
    Reading:2, Sheffield:1, Southampton:2,
  },
  callOutAllocation: {
    Birmingham:2, Bristol:2, Cambridge:2, Cardiff:1, Colchester:1,
    Edinburgh:2, Gatwick:2, Glasgow:2, Leeds:2, Leicester:1,
    Liverpool:2, Manchester:2, "Milton Keynes":2, Oxford:1,
    Reading:2, Sheffield:2, Southampton:1,
  },
  offices: ["Birmingham","Bristol","Cambridge","Cardiff","Colchester","Edinburgh","Gatwick","Glasgow","Leeds","Leicester","Liverpool","Manchester","Milton Keynes","Oxford","Reading","Sheffield","Southampton"],
  issueCategoryId: "c3a2c651-8e31-4c10-a0eb-eae123f15f18",
  healthCheckTemplateId: "template_58624410208f4025b0757d47d04008d1",
  officeHCVTemplateId:   "template_a68b6c7b138e438f89c8706ff3b7ea37",

  // Action label name → category
  warrantyLabel:        "Warranty Call Out",
  clientDelayLabel:     "Client Delay",
  remoteResolutionLabel:"Remote Resolution",
  faultLabels:          ["Room Down","Partial Fault","Routine"],
  // Site visit labels — these indicate an engineer went to site (counts as call-out)
  siteVisitLabels:      ["Hardware Replacement","Re-Cabling","Re-Configuration","Consumable","No Fault Found","HCV Completed"],
  resolutionLabels:     ["Hardware Replacement","Re-Cabling","Re-Configuration","Consumable","No Fault Found","HCV Completed","Remote Resolution"],

  // Label IDs (for future use)
  labelIds: {
    clientDelay:      "48226bf8-50f9-4c3a-a934-6dd6b6cca5ba",
    remoteResolution: "f26c5433-7619-4cec-8e60-e8c9fed01a37",
    warrantyCallOut:  "d1430b07-add5-4f4d-820f-e1219fc945d9",
  },
};

const TOTAL_CALLOUT_ALLOC = Object.values(CONFIG.callOutAllocation).reduce((a,b)=>a+b,0);
const FAULTS = ["Room Down","Partial Fault","Routine"];

/* ----------------------------------------------------------------
   Business hours calculator (Mon-Fri 8am-6pm UK time, excl. bank holidays)
   Converts all timestamps to UK local time (handles GMT/BST automatically)
   before applying the 8am-6pm window.
---------------------------------------------------------------- */

// Get UK local hour (handles BST/GMT automatically)
function ukHour(dt) {
  const s = dt.toLocaleString("en-GB", { timeZone:"Europe/London", hour:"2-digit", minute:"2-digit", hour12:false });
  const [h, m] = s.split(":").map(Number);
  return h + m/60;
}

// Get UK local date string YYYY-MM-DD
function ukDateKey(dt) {
  return dt.toLocaleDateString("en-GB", { timeZone:"Europe/London", year:"numeric", month:"2-digit", day:"2-digit" })
    .split("/").reverse().join("-");
}

function isWorkday(dt) {
  // Use UK local day of week
  const dow = new Date(dt.toLocaleString("en-US", { timeZone:"Europe/London" })).getDay();
  if (dow === 0 || dow === 6) return false;
  return !bankHolidays.has(ukDateKey(dt));
}

function nextBusinessOpen(dt) {
  const S = CONFIG.workdayStart, E = CONFIG.workdayEnd;
  const d = new Date(dt);
  const h = ukHour(d);

  if (isWorkday(d) && h >= S && h < E) return d;

  // Before hours on a workday — clamp to 8am UK same day
  if (isWorkday(d) && h < S) {
    // Find 8am UK time for this date
    const dateStr = ukDateKey(d);
    const clamped = new Date(`${dateStr}T00:00:00`);
    // Adjust to get exactly 8am UK time
    const testH = ukHour(clamped);
    clamped.setTime(clamped.getTime() + (S - testH) * 3600000);
    return clamped;
  }

  // After hours or weekend — advance to next workday 8am
  const next = new Date(d);
  next.setTime(next.getTime() + 24*3600000);
  // Reset to start of day UK time
  const nextDateStr = ukDateKey(next);
  const nextDay = new Date(`${nextDateStr}T00:00:00Z`);
  // Find 8am UK for that day
  for (let offset = 0; offset <= 6; offset++) {
    const try_ = new Date(nextDay.getTime() + offset * 24*3600000);
    if (isWorkday(try_)) {
      const h0 = ukHour(try_);
      try_.setTime(try_.getTime() + (S - h0) * 3600000);
      return try_;
    }
  }
  return next;
}

function businessHoursBetween(startISO, endISO) {
  if (!startISO || !endISO) return null;
  const start = nextBusinessOpen(new Date(startISO));
  const end   = new Date(endISO);
  if (end <= start) return 0;
  const S = CONFIG.workdayStart, E = CONFIG.workdayEnd;

  let total = 0;
  // Iterate day by day in UK date space
  const startDateKey = ukDateKey(start);
  const endDateKey   = ukDateKey(end);

  // Build list of UK dates to iterate
  const cur = new Date(start);
  cur.setUTCHours(0,0,0,0);
  const endDay = new Date(end);
  endDay.setUTCHours(0,0,0,0);

  while (cur <= endDay) {
    const curKey = ukDateKey(cur);
    if (isWorkday(cur)) {
      let ds = S, de = E;
      if (curKey === startDateKey) { const h=ukHour(start); ds=Math.max(S,Math.min(E,h)); }
      if (curKey === endDateKey)   { const h=ukHour(end);   de=Math.max(S,Math.min(E,h)); }
      if (de > ds) total += de - ds;
    }
    cur.setUTCDate(cur.getUTCDate()+1);
  }
  return +total.toFixed(2);
}

/* ---------------------------------------------------------------- utils */
const mKey = d => { const x=new Date(d); return `${x.getFullYear()}-${String(x.getMonth()+1).padStart(2,"0")}`; };
const now  = () => new Date();

function last6Months() {
  const out = [];
  for (let i=5;i>=0;i--) {
    const m = new Date(now().getFullYear(), now().getMonth()-i, 1);
    out.push({ key:mKey(m), label:m.toLocaleDateString("en-GB",{month:"short",year:"2-digit"}) });
  }
  return out;
}

function matchOffice(s) {
  if (!s) return "Other";
  const sl = s.toLowerCase();
  for (const o of CONFIG.offices) { if (sl.includes(o.toLowerCase())) return o; }
  return s;
}

function pick(o, keys) {
  for (const k of keys) if (o[k]!=null && o[k]!=="") return o[k];
  return null;
}

/* ----------------------------------------------------------------
   Parse action_label pipe-separated JSON string
   e.g. {"label_id":"xxx"|"label_name":"Partial Fault"}|{"label_id":"yyy"|"label_name":"Re-Configuration"}
---------------------------------------------------------------- */
function parseActionLabels(labelStr) {
  if (!labelStr) return [];
  try {
    // Replace pipe-separators between objects, fix internal pipes to commas
    const fixed = "[" + labelStr
      .split("}|{").join("},{")
      .replace(/\|/g, ",") + "]";
    const arr = JSON.parse(fixed);
    return arr.map(l => l.label_name || l.labelName || "").filter(Boolean);
  } catch {
    // Fallback: extract label_name values with regex
    const names = [];
    const re = /"label_name"\s*[:|,]\s*"([^"]+)"/g;
    let m;
    while ((m = re.exec(labelStr)) !== null) names.push(m[1]);
    return names;
  }
}

/* ----------------------------------------------------------------
   Match issue to actions by call reference number in title
   Issue title = "F2570732 - The Exchange"
   Action title = "F2570732 - No mic audio" or "F2570732 - Ryder Screen"
   Matches on the reference number only (first word before space/dash)
   Returns ALL matching actions so labels from all are collected
---------------------------------------------------------------- */
function matchIssueToActions(issue, actions) {
  // Extract just the reference number e.g. "F2570732" from "F2570732 - The Exchange"
  const ref = (issue.title || "").split(/[\s-]/)[0].trim();
  if (!ref || ref.length < 3) return [];
  return actions.filter(a => {
    const t = (a.title || "");
    return t === ref || t.startsWith(ref + " ") || t.startsWith(ref + "-") || t.startsWith(ref + " -");
  });
}

/* ---------------------------------------------------------------- SC API */
async function scFetch(p) {
  const r = await fetch(`${SC_BASE}${p}`, { headers:{ Authorization:`Bearer ${SC_TOKEN}`, Accept:"application/json" } });
  if (!r.ok) throw new Error(`SC ${p} -> ${r.status}`);
  return r.json();
}

async function pullFeed(p) {
  let url=p, rows=[], guard=0;
  while (url && guard<200) {
    guard++;
    const j = await scFetch(url);
    rows.push(...(j.data||[]));
    url = j.metadata?.next_page || null;
  }
  return rows;
}

/* ---------------------------------------------------------------- live */
async function buildLiveReport(reportingMonthKey=null) {
  await loadBankHolidays();
  const start = new Date(CONFIG.reportStartDate);

  // Pull Issues (Client Service Requests)
  const allIssues = await pullFeed(`/feed/issues`).catch(()=>[]);
  const issues = allIssues.filter(i =>
    i.category_id === CONFIG.issueCategoryId &&
    new Date(i.created_at||0) >= start
  );

  // Pull Actions
  const allActions = await pullFeed(`/feed/actions`).catch(()=>[]);

  // Build cases by matching issues to actions
  const cases = issues.map(issue => {
    const matchedActions = matchIssueToActions(issue, allActions);
    const labels = matchedActions.flatMap(a => parseActionLabels(a.action_label));

    const fault            = labels.find(l => FAULTS.includes(l)) || "Routine";
    const resolution       = labels.find(l => CONFIG.resolutionLabels.includes(l)) || null;
    const warranty         = labels.includes(CONFIG.warrantyLabel);
    const clientDelay      = labels.includes(CONFIG.clientDelayLabel);
    const remoteResolution = labels.includes(CONFIG.remoteResolutionLabel);
    const siteVisit        = labels.some(l => CONFIG.siteVisitLabels.includes(l));

    const occurredAt  = issue.occurred_at || issue.created_at;
    const respondedAt = issue.created_at;
    const firstAction = matchedActions[0] || null;
    const siteVisitAt = firstAction?.created_at || null;
    const resolvedAt  = firstAction?.completed_at || null;
    const isClosed    = !!(resolvedAt || issue.status === "CLOSED" || issue.completed_at);
    const closedAt    = issue.completed_at || resolvedAt || null;

    // KPI 1 — Response time (contractual SLA) = issue.created_at − issue.occurred_at
    const responseHrs = businessHoursBetween(occurredAt, respondedAt);

    // KPI 2 — Time to site visit = action.created_at − issue.occurred_at
    const siteVisitHrs = siteVisitAt ? businessHoursBetween(occurredAt, siteVisitAt) : null;

    // KPI 3 — Full resolution = action.completed_at − issue.occurred_at
    const resolutionHrs = resolvedAt ? businessHoursBetween(occurredAt, resolvedAt) : null;

    return {
      id:            issue.id,
      title:         issue.title || "Issue",
      fault,
      contactMethod: "Unknown", // not available in feed/issues
      status:        isClosed ? "Closed" : "Open",
      occurredAt,
      respondedAt,
      siteVisitAt,
      closedAt,
      responseHrs,
      siteVisitHrs,
      resolutionHrs,
      resolution,
      warranty,
      clientDelay,
      remoteResolution,
      siteVisit,
      office:        matchOffice(issue.site_name),
      room:          issue.site_name || "—",
      callReference: issue.title,
    };
  });

  // Inspections for HCV
  const thisYearStart = new Date(now().getFullYear(), 0, 1);
  const allInsp = await pullFeed(`/feed/inspections?modified_after=${encodeURIComponent(CONFIG.reportStartDate)}`).catch(()=>[]);
  const sitesRaw = await pullFeed("/feed/sites").catch(()=>[]);
  const siteMap = {};
  sitesRaw.forEach(s=>{ siteMap[pick(s,["id","site_id"])] = pick(s,["name","site_name"])||"—"; });

  const hcvRows = allInsp
    .filter(i=>pick(i,["template_id","templateId"])===CONFIG.healthCheckTemplateId)
    .map(i=>({
      ref:(pick(i,["audit_id","inspection_id","id"])||"").toString().slice(-8),
      room:siteMap[pick(i,["site_id","site"])]||"—",
      status:pick(i,["date_completed","completed_at"])?"Completed":"In Progress",
      scheduled:pick(i,["created_at","date_started"]),
      completed:pick(i,["date_completed","completed_at"]),
    }));

  const officeHCVInsp = allInsp.filter(i=>
    pick(i,["template_id","templateId"])===CONFIG.officeHCVTemplateId &&
    new Date(pick(i,["created_at","date_started","date_completed"])||0) >= thisYearStart
  );

  const officeHCVRaw = await Promise.all(officeHCVInsp.map(async i => {
    const id = String(pick(i,["audit_id","inspection_id","id"])||"");
    const details = await scFetch(`/inspections/v1/inspections/${id}/details`).catch(()=>null);
    const siteLbl = siteMap[pick(i,["site_id","site"])]||"—";
    function getF(kw) {
      const items = details?.inspection?.items||[];
      function walk(arr) {
        for (const it of arr) {
          if ((it.label||"").toLowerCase().includes(kw)) {
            if (it.datetime_item?.datetime) return it.datetime_item.datetime;
            if (it.text_item?.text) return it.text_item.text;
            if (it.list_items?.responses?.length) return it.list_items.responses[0].value;
          }
          const f=walk(it.items||it.children||[]); if(f) return f;
        }
        return null;
      }
      return walk(items);
    }
    const scheduledRaw=getF("scheduled"), visitNumRaw=getF("visit"), outcome=getF("outcome")||getF("general state")||"—";
    const completed=pick(i,["date_completed","completed_at"]), isCompleted=!!completed;
    const sd=scheduledRaw?new Date(scheduledRaw):null;
    const status=isCompleted?"Completed":sd&&sd<now()?"Overdue":sd&&sd>=now()?"Booked":"In Progress";
    return { id, office:matchOffice(siteLbl), visitNum:visitNumRaw&&String(visitNumRaw).includes("2")?2:1,
             status, scheduled:scheduledRaw||null, completed:completed||null, outcome };
  }));

  const officeHCVSummary = CONFIG.offices.map(o => {
    const visits=officeHCVRaw.filter(h=>h.office===o);
    const v1=visits.find(h=>h.visitNum===1)||null, v2=visits.find(h=>h.visitNum===2)||null;
    const allowedVisits=CONFIG.hcvVisits[o]||2;
    const mkSlot=v=>v?{status:v.status,scheduled:v.scheduled,completed:v.completed,outcome:v.outcome}:{status:"Not scheduled",scheduled:null,completed:null,outcome:null};
    const visit2Slot = allowedVisits<2
      ? {status:"N/A",scheduled:null,completed:null,outcome:null}
      : mkSlot(v2);
    return {office:o,visit1:mkSlot(v1),visit2:visit2Slot,allowedVisits};
  });

  const report = computeMetrics(cases, hcvRows, officeHCVSummary, reportingMonthKey);
  report.meta.mode = "live";
  report.improvements = improvements;
  report.meta.connection = {
    issuesPulled:    allIssues.length,
    casesInPeriod:   cases.length,
    actionsPulled:   allActions.length,
    inspectionsPulled: allInsp.length,
    officeHCVPulled: officeHCVInsp.length,
  };
  return report;
}

/* ---------------------------------------------------------------- metrics */
function computeMetrics(cases, hcvRows, officeHCVSummary=[], reportingMonthKey=null) {
  const months = last6Months();
  const curKey = reportingMonthKey || months[months.length-2].key;
  const curMonth = months.find(m=>m.key===curKey)||months[months.length-2];
  const t = CONFIG.targets;

  const closed    = cases.filter(c=>c.status==="Closed");
  const open      = cases.filter(c=>c.status==="Open");
  const slaClosed = closed.filter(c=>!c.warranty);

  const trendLoggedClosed = months.map(m=>({
    month:  m.label,
    logged: cases.filter(c=>mKey(c.respondedAt)===m.key).length,
    closed: closed.filter(c=>mKey(c.closedAt)===m.key).length,
  }));

  // SLA performance — response time vs targets (contractual KPI)
  const slaByCategory = FAULTS.map(f=>{
    const cc = slaClosed.filter(c=>c.fault===f&&c.responseHrs!=null);
    const avg = cc.length ? cc.reduce((s,c)=>s+c.responseHrs,0)/cc.length : 0;
    return {fault:f, avg:+avg.toFixed(2), target:t[f], within:cc.length?avg<=t[f]:true, count:cc.length};
  });

  // Site visit averages — with and without client delay
  const siteVisitAvg = FAULTS.map(f=>{
    const all  = slaClosed.filter(c=>c.fault===f&&c.siteVisitHrs!=null);
    const excl = all.filter(c=>!c.clientDelay);
    const avgAll  = all.length  ? +(all.reduce((s,c)=>s+c.siteVisitHrs,0)/all.length).toFixed(2)  : null;
    const avgExcl = excl.length ? +(excl.reduce((s,c)=>s+c.siteVisitHrs,0)/excl.length).toFixed(2) : null;
    return {fault:f, avgAll, avgExcl, countAll:all.length, countExcl:excl.length};
  });

  // Full resolution averages
  const resolutionAvg = FAULTS.map(f=>{
    const cc = slaClosed.filter(c=>c.fault===f&&c.resolutionHrs!=null);
    const avg = cc.length ? +(cc.reduce((s,c)=>s+c.resolutionHrs,0)/cc.length).toFixed(2) : null;
    return {fault:f, avg, count:cc.length};
  });

  // 6-month response time trend
  const slaTrend = months.map(m=>{
    const row={month:m.label};
    FAULTS.forEach(f=>{
      const cc=slaClosed.filter(c=>c.fault===f&&mKey(c.closedAt)===m.key&&c.responseHrs!=null);
      row[f]=cc.length?+(cc.reduce((s,c)=>s+c.responseHrs,0)/cc.length).toFixed(2):null;
    });
    return row;
  });

  // Breached cases (response time vs SLA target)
  const breachedCases = slaClosed
    .filter(c=>c.responseHrs!=null&&c.responseHrs>t[c.fault])
    .map(c=>({title:c.title,fault:c.fault,room:c.room,office:c.office,
               callReference:c.callReference,hrs:c.responseHrs,
               target:t[c.fault],over:+(c.responseHrs-t[c.fault]).toFixed(2),
               closed:c.closedAt,clientDelay:c.clientDelay}))
    .sort((a,b)=>b.over-a.over).slice(0,20);

  // Room and resolution breakdowns
  // All closed cases (SLA + warranty) for charts
  const allClosed = closed; // includes warranty

  const roomCount={};
  allClosed.forEach(c=>{roomCount[c.room]=(roomCount[c.room]||0)+1;});
  const topRooms=Object.entries(roomCount).sort((a,b)=>b[1]-a[1]).slice(0,7).map(([name,value])=>({name,value}));
  const topRoomNames=topRooms.slice(0,5).map(r=>r.name);
  const roomTrend=months.map(m=>{
    const row={month:m.label};
    topRoomNames.forEach(r=>{
      row[r]       = slaClosed.filter(c=>c.room===r&&mKey(c.closedAt)===m.key).length;
      row[r+"_w"]  = allClosed.filter(c=>c.warranty&&c.room===r&&mKey(c.closedAt)===m.key).length;
    });
    return row;
  });

  const resCount={};
  allClosed.forEach(c=>{const r=c.resolution||"Not recorded";resCount[r]=(resCount[r]||0)+1;});
  const byResolution=Object.entries(resCount).sort((a,b)=>b[1]-a[1]).map(([name,value])=>({name,value}));
  const topResNames=byResolution.slice(0,5).map(r=>r.name);
  const resTrend=months.map(m=>{
    const row={month:m.label};
    topResNames.forEach(r=>{
      row[r]      = slaClosed.filter(c=>(c.resolution||"Not recorded")===r&&mKey(c.closedAt)===m.key).length;
      row[r+"_w"] = allClosed.filter(c=>c.warranty&&(c.resolution||"Not recorded")===r&&mKey(c.closedAt)===m.key).length;
    });
    return row;
  });

  // Service calls trend — all cases including warranty
  const allCasesServiceTrend = months.map(m=>({
    month:m.label,
    sla:     cases.filter(c=>!c.warranty&&mKey(c.respondedAt)===m.key).length,
    warranty:cases.filter(c=>c.warranty&&mKey(c.respondedAt)===m.key).length,
  }));

  // Office allocations
  const officeUsage={}, warrantyByOffice={}, remoteByOffice={};
  cases.forEach(c=>{
    if(c.warranty){
      warrantyByOffice[c.office]=(warrantyByOffice[c.office]||0)+1;
    } else if(c.remoteResolution){
      remoteByOffice[c.office]=(remoteByOffice[c.office]||0)+1;
    } else if(c.siteVisit){
      // Only site visits count against call-out allocation
      officeUsage[c.office]=(officeUsage[c.office]||0)+1;
    }
  });
  const allOffices=new Set([...CONFIG.offices,...Object.keys(officeUsage)]);
  const officeAllocations=[...allOffices].map(o=>{
    const used=officeUsage[o]||0, alloc=CONFIG.callOutAllocation[o]||1;
    const pct=+(used/alloc*100).toFixed(1);
    return {office:o,alloc,used,remaining:alloc-used,pct,
            rag:pct>=90?"red":pct>=60?"amber":"green",
            warranty:warrantyByOffice[o]||0,
            remote:remoteByOffice[o]||0};
  }).sort((a,b)=>b.pct-a.pct);

  // Current month
  const curCases  = cases.filter(c=>mKey(c.respondedAt)===curKey);
  const curClosed = slaClosed.filter(c=>mKey(c.closedAt)===curKey);
  const openCases = open.map(c=>({
    title:c.title, fault:c.fault, room:c.room, office:c.office,
    callReference:c.callReference, created:c.respondedAt,
    ageHours:c.occurredAt?businessHoursBetween(c.occurredAt,now().toISOString()):null,
    warranty:c.warranty||false, clientDelay:c.clientDelay||false,
  }));

  const openByCategory={};
  FAULTS.forEach(f=>{openByCategory[f]=open.filter(c=>c.fault===f&&!c.warranty).length;});
  const roomDownBreaches=open.filter(c=>!c.warranty&&c.fault==="Room Down"&&
    c.occurredAt&&businessHoursBetween(c.occurredAt,now().toISOString())>t["Room Down"]).length;

  // HCV
  const expectedTotal=Object.values(CONFIG.hcvVisits).reduce((a,b)=>a+b,0);
  const allVisitSlots=officeHCVSummary.flatMap(o=>{
    const slots=[o.visit1];
    if(o.visit2?.status!=="N/A") slots.push(o.visit2);
    return slots;
  });

  return {
    meta:{mode:"sample",generatedAt:now().toISOString(),company:CONFIG.companyName,
          monthsLabels:months.map(m=>m.label),monthsKeys:months.map(m=>m.key),
          reportingMonth:curKey,reportingMonthLabel:curMonth.label,slaRef:"TECHPR-0510"},
    targets:t, responseTargets:CONFIG.responseTargets, callOutAllocationTotal:TOTAL_CALLOUT_ALLOC,
    kpis:{loggedThisMonth:curCases.length,closedThisMonth:curClosed.length,openNow:open.length,roomDownBreaches},
    warrantyThisMonth:curCases.filter(c=>c.warranty).length,
    warrantyThisMonthCases:curCases.filter(c=>c.warranty).map(c=>({title:c.title,fault:c.fault,room:c.room,created:c.respondedAt,status:c.status,warranty:true})),
    openByCategory, roomDownBreaches,
    trendLoggedClosed, slaByCategory, siteVisitAvg, resolutionAvg, slaTrend, breachedCases,
    resolutionBreakdown:{
      siteVisit:   cases.filter(c=>!c.warranty&&c.siteVisit).length,
      remote:      cases.filter(c=>!c.warranty&&c.remoteResolution).length,
      unrecorded:  cases.filter(c=>!c.warranty&&!c.siteVisit&&!c.remoteResolution&&c.status==="Closed").length,
    },
    topRooms, topRoomNames, roomTrend, byResolution, topResNames, resTrend,
    serviceCalls:{month:curCases.length,sixMonth:cases.length,
      trend:months.map(m=>({month:m.label,visits:cases.filter(c=>mKey(c.respondedAt)===m.key).length})),
      allTrend:allCasesServiceTrend},
    hcv:{scheduled:hcvRows.length,completed:hcvRows.filter(h=>h.status==="Completed").length,
         inProgress:hcvRows.filter(h=>h.status==="In Progress").length,
         outstanding:hcvRows.filter(h=>h.status==="Scheduled").length,rows:hcvRows.slice(0,15)},
    officeHCV:{expected:expectedTotal,
               completed:allVisitSlots.filter(v=>v.status==="Completed").length,
               booked:allVisitSlots.filter(v=>v.status==="Booked").length,
               overdue:allVisitSlots.filter(v=>v.status==="Overdue").length,
               notScheduled:allVisitSlots.filter(v=>v.status==="Not scheduled").length,
               summary:officeHCVSummary},
    officeAllocations,
    loggedThisMonthCases:curCases.map(c=>({title:c.title,fault:c.fault,room:c.room,
      created:c.respondedAt,status:c.status,warranty:c.warranty||false,callReference:c.callReference})),
    closedThisMonthCases:curClosed.map(c=>({title:c.title,fault:c.fault,room:c.room,
      closed:c.closedAt,resolution:c.resolution,warranty:false,callReference:c.callReference,
      responseHrs:c.responseHrs,siteVisitHrs:c.siteVisitHrs,resolutionHrs:c.resolutionHrs,
      clientDelay:c.clientDelay})),
    openCases, improvements,
  };
}

/* ---------------------------------------------------------------- sample */
function buildSampleReport(reportingMonthKey=null) {
  const months=last6Months();
  const roomDefs=[
    {room:"Leeds - Ryder",office:"Leeds"},{room:"Leeds - The Exchange",office:"Leeds"},
    {room:"Birmingham - Colmore",office:"Birmingham"},{room:"Manchester - Hardman",office:"Manchester"},
    {room:"Bristol - Glass Wharf",office:"Bristol"},{room:"Edinburgh - Atria",office:"Edinburgh"},
  ];
  const cases=[];
  months.forEach((m,mi)=>{
    const n=[4,6,5,4,7,2][mi]||5;
    for (let i=0;i<n;i++) {
      const fault=i%7===0?"Room Down":i%2?"Partial Fault":"Routine";
      const [y,mo]=m.key.split("-");
      const occurred=new Date(+y,+mo-1,2+(i*2)%25,8+(i%3));
      const responseDelay=0.2+(i%4)*0.3;
      const responded=new Date(occurred.getTime()+responseDelay*36e5);
      const siteDelay=responseDelay+(i%3)*2;
      const siteVisit=new Date(occurred.getTime()+siteDelay*36e5);
      const isOpen=mi===5&&i%5===0;
      const tgt=fault==="Room Down"?8:fault==="Partial Fault"?24:120;
      const resH=i%6===0?tgt*1.8:tgt*(0.2+(i%4)*0.15);
      const closedAt=isOpen?null:new Date(occurred.getTime()+resH*36e5);
      const rd=roomDefs[(mi*3+i)%roomDefs.length];
      const clientDelay=i%8===0;
      cases.push({
        id:`s-${mi}-${i}`, title:`GT-${2570000+mi*100+i}`, fault,
        contactMethod:i%3===0?"Phone Call":"Email",
        status:isOpen?"Open":"Closed",
        occurredAt:occurred.toISOString(), respondedAt:responded.toISOString(),
        siteVisitAt:isOpen?null:siteVisit.toISOString(),
        closedAt:closedAt?.toISOString()||null,
        responseHrs:+responseDelay.toFixed(2),
        siteVisitHrs:isOpen?null:+(businessHoursBetween(occurred.toISOString(),siteVisit.toISOString())||0).toFixed(2),
        resolutionHrs:isOpen?null:+(businessHoursBetween(occurred.toISOString(),closedAt?.toISOString()||null)||0).toFixed(2),
        resolution:isOpen?null:["Re-Configuration","Hardware Replacement","Re-Cabling","No Fault Found","Consumable"][i%5],
        siteVisit:!isOpen&&i%4!==0,        // ~75% are site visits
        remoteResolution:!isOpen&&i%4===0, // ~25% resolved remotely
        warranty:false, clientDelay, office:rd.office, room:rd.room,
        callReference:`GT-${2570000+mi*100+i}`,
      });
    }
  });

  const hcvRows=[
    {ref:"HCV-001",room:"Event Rooms (Leeds)",status:"Completed",scheduled:"2025-09-15",completed:"2025-12-19"},
    {ref:"HCV-002",room:"Event Rooms (London)",status:"In Progress",scheduled:"2025-11-01",completed:null},
  ];

  const sampleStatuses=[
    ["Completed","Booked"],["Booked","N/A"],["Not scheduled","Not scheduled"],
    ["Completed","N/A"],["Overdue","N/A"],["Booked","N/A"],
    ["Not scheduled","Not scheduled"],["Completed","Booked"],["Overdue","Booked"],
    ["Not scheduled","Not scheduled"],["Booked","Not scheduled"],["Completed","Not scheduled"],
    ["Not scheduled","N/A"],["Booked","Not scheduled"],["Completed","Booked"],
    ["Overdue","N/A"],["Not scheduled","Not scheduled"],
  ];
  const mkDate=d=>new Date(now().getTime()+d*864e5).toISOString();
  const officeHCVSummary=CONFIG.offices.map((o,i)=>{
    const allowed=CONFIG.hcvVisits[o]||1;
    const [s1,s2raw]=sampleStatuses[i]||["Not scheduled","Not scheduled"];
    const s2=allowed<2?"N/A":s2raw;
    const mkV=s=>s==="N/A"?{status:"N/A",scheduled:null,completed:null,outcome:null}:
      ({status:s,outcome:s==="Completed"?(i%3===0?"Minor Issues":"All Good"):null,
      scheduled:s==="Not scheduled"?null:s==="Completed"?mkDate(-60):s==="Overdue"?mkDate(-5):mkDate(30),
      completed:s==="Completed"?mkDate(-45):null});
    return {office:o,visit1:mkV(s1),visit2:mkV(s2),allowedVisits:allowed};
  });

  const report=computeMetrics(cases,hcvRows,officeHCVSummary,reportingMonthKey);
  report.meta.mode="sample";
  report.meta.connection=null;
  report.improvements=improvements.length?improvements:[];
  return report;
}

/* ---------------------------------------------------------------- routes */
app.use(express.json());

app.get("/api/report", async (req,res)=>{
  const m=req.query.month||null;
  try {
    if (!SC_TOKEN) return res.json(buildSampleReport(m));
    res.json(await buildLiveReport(m));
  } catch(err) { console.error(err); res.json({error:err.message,fallback:buildSampleReport(m)}); }
});

app.get("/api/improvements",        (req,res)=>res.json(improvements));
app.post("/api/improvements",       (req,res)=>{ const item={...req.body,id:"imp-"+Date.now()}; improvements.push(item); saveImprovements(improvements); res.json(item); });
app.put("/api/improvements/:id",    (req,res)=>{ const idx=improvements.findIndex(i=>i.id===req.params.id); if(idx===-1)return res.status(404).json({error:"Not found"}); improvements[idx]={...improvements[idx],...req.body}; saveImprovements(improvements); res.json(improvements[idx]); });
app.delete("/api/improvements/:id", (req,res)=>{ improvements=improvements.filter(i=>i.id!==req.params.id); saveImprovements(improvements); res.json({ok:true}); });

app.use(express.static(path.join(__dirname,"public")));
app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));

app.listen(PORT,()=>console.log(`AV Dashboard on port ${PORT} — ${SC_TOKEN?"LIVE":"SAMPLE DATA"}`));
