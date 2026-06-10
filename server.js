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
  visitsPerOfficePerYear: 2,
  callOutAllocation: {
    Birmingham:2, Bristol:2, Cambridge:2, Cardiff:1, Colchester:1,
    Edinburgh:2, Gatwick:2, Glasgow:2, Leeds:2, Leicester:1,
    Liverpool:2, Manchester:2, "Milton Keynes":2, Oxford:1,
    Reading:2, Sheffield:2, Southampton:1,
  },
  offices: ["Birmingham","Bristol","Cambridge","Cardiff","Colchester","Edinburgh","Gatwick","Glasgow","Leeds","Leicester","Liverpool","Manchester","Milton Keynes","Oxford","Reading","Sheffield","Southampton"],
  investigationCategoryId: "b1d1eef2-e320-4e6d-b9f2-4a21896f5d68",
  issueCategoryId: "c3a2c651-8e31-4c10-a0eb-eae123f15f18",
  investigationClosedStatusId: "6b4c8390-a0aa-4f93-bacc-acfc15d8f1f4",
  fields: {
    contactMethod:     "d69e29a1-45be-4f65-a5de-b138d5341dbe",
    clientContactTime: "a98cee63-d1a0-408f-bac3-bd14817bb4b7",
    faultType:         "80b3fbc0-382e-4d39-95eb-dbd5a3ed0b49",
    site:              "75dac7c2-89bc-49a4-a232-1ba05c95a294",
  },
  resolutionLabels: {
    "d60f6de1-0460-4b47-946f-3d8f4bd1597a":"Consumable",
    "e4d92d16-50d9-4b0f-8b65-a31eb293b4d5":"Hardware Replacement",
    "53d52972-ae9f-408c-8aaf-b8e1222f4477":"HCV Completed",
    "fe41d6d1-2a0f-4d09-b4bc-561f2c002dae":"No Fault Found",
    "22bff331-0d27-472e-a960-2dd014856af4":"Re-Cabling",
    "397f81eb-a2b7-46e0-8f94-770577c0a323":"Re-Configuration",
    "d1430b07-add5-4f4d-820f-e1219fc945d9":"Warranty Call Out",
  },
  healthCheckTemplateId: "template_58624410208f4025b0757d47d04008d1",
  officeHCVTemplateId:   "template_a68b6c7b138e438f89c8706ff3b7ea37",
};

const TOTAL_CALLOUT_ALLOC = Object.values(CONFIG.callOutAllocation).reduce((a,b)=>a+b,0);
const FAULTS = ["Room Down","Partial Fault","Routine"];
const NULL_DATE = "0001-01-01";

/* ----------------------------------------------------------------
   Business hours calculator (Mon-Fri, 8am-6pm, excl. UK bank holidays)
---------------------------------------------------------------- */
function businessHoursBetween(startISO, endISO) {
  if (!startISO || !endISO) return null;
  const start = new Date(startISO);
  const end   = new Date(endISO);
  if (end <= start) return 0;
  const S = CONFIG.workdayStart, E = CONFIG.workdayEnd;

  function isWorkday(dt) {
    const d = dt.getUTCDay();
    if (d === 0 || d === 6) return false;
    return !bankHolidays.has(dt.toISOString().slice(0,10));
  }

  let total = 0;
  const cur = new Date(start); cur.setUTCHours(0,0,0,0);
  const endDay = new Date(end); endDay.setUTCHours(0,0,0,0);

  while (cur <= endDay) {
    if (isWorkday(cur)) {
      const sameAsStart = cur.toISOString().slice(0,10) === start.toISOString().slice(0,10);
      const sameAsEnd   = cur.toISOString().slice(0,10) === end.toISOString().slice(0,10);
      let ds = S, de = E;
      if (sameAsStart) { const h=start.getUTCHours()+start.getUTCMinutes()/60; ds=Math.max(S,Math.min(E,h)); }
      if (sameAsEnd)   { const h=end.getUTCHours()+end.getUTCMinutes()/60;   de=Math.max(S,Math.min(E,h)); }
      if (de > ds) total += de - ds;
    }
    cur.setUTCDate(cur.getUTCDate()+1);
  }
  return +total.toFixed(2);
}

/* ---------------------------------------------------------------- utils */
const mKey = d => { const x=new Date(d); return `${x.getFullYear()}-${String(x.getMonth()+1).padStart(2,"0")}`; };
const now  = () => new Date();
const isNullDate = d => !d || d.startsWith(NULL_DATE);

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

function getDetailField(fields, fieldId) {
  if (!Array.isArray(fields)) return null;
  const f = fields.find(f=>f.fieldId===fieldId);
  if (!f) return null;
  if (f.dateTime?.datetime && !isNullDate(f.dateTime.datetime)) return f.dateTime.datetime;
  if (f.singleSelect?.selected) return f.singleSelect.selected;
  if (f.singleSelect?.value)    return f.singleSelect.value;
  if (f.site?.name)             return f.site.name;
  if (f.text)                   return f.text;
  return null;
}

/* ---------------------------------------------------------------- SC API */
async function scFetch(p) {
  const r = await fetch(`${SC_BASE}${p}`, { headers:{ Authorization:`Bearer ${SC_TOKEN}`, Accept:"application/json" } });
  if (!r.ok) throw new Error(`SC ${p} -> ${r.status}`);
  return r.json();
}

async function pullPaged(p) {
  let url=p, rows=[], guard=0;
  while (url && guard<200) {
    guard++;
    const j = await scFetch(url);
    const items = j.investigations || j.issues || j.tasks || j.data || [];
    rows.push(...items);
    const next = j.metadata?.next_page || j.nextPage;
    url = next ? (next.startsWith("http") ? next.replace(SC_BASE,"") : next) : null;
  }
  return rows;
}

async function getLinkedIssue(invId) {
  try {
    const j = await scFetch(`/investigations/v1/investigations/${invId}/issues`);
    return (j.issues||j.data||[])[0] || null;
  } catch { return null; }
}

async function getLinkedActions(invId) {
  try {
    const j = await scFetch(`/investigations/v1/investigations/${invId}/actions`);
    return j.tasks||j.actions||j.data||[];
  } catch { return []; }
}

/* ---------------------------------------------------------------- live */
async function buildLiveReport(reportingMonthKey=null) {
  await loadBankHolidays();
  const start = new Date(CONFIG.reportStartDate);
  const thisYearStart = new Date(now().getFullYear(), 0, 1);

  const rawInv = await pullPaged(`/investigations/v1/investigations?categoryId=${CONFIG.investigationCategoryId}`).catch(()=>[]);
  const investigations = rawInv.filter(i => new Date(i.createdAt||i.created_at||0) >= start);

  const cases = await Promise.all(investigations.map(async inv => {
    const df = inv.detailFields || inv.detail_fields || [];
    const clientContactTime = getDetailField(df, CONFIG.fields.clientContactTime);
    const contactMethod     = getDetailField(df, CONFIG.fields.contactMethod) || "Unknown";
    const faultType         = getDetailField(df, CONFIG.fields.faultType) || "Routine";
    const siteName          = getDetailField(df, CONFIG.fields.site) || "—";
    const invId             = inv.investigationId || inv.id;

    const isClosed = inv.statusId===CONFIG.investigationClosedStatusId ||
                     inv.status?.id===CONFIG.investigationClosedStatusId ||
                     inv.status?.title?.toLowerCase()==="closed";
    const closedAt  = isClosed ? (inv.closedAt||inv.closed_at||null) : null;
    const createdAt = inv.createdAt||inv.created_at;

    const linkedIssue    = await getLinkedIssue(invId);
    const callReference  = linkedIssue?.questions?.find(q=>q.questionId==="0593579a-118c-49ec-9c30-0f2c47966e28")?.answer || linkedIssue?.title || null;
    const issueCreatedAt = linkedIssue?.createdAt || null;

    const responseHrs   = (issueCreatedAt && clientContactTime) ? businessHoursBetween(clientContactTime, issueCreatedAt) : null;
    const resolutionHrs = (closedAt && clientContactTime)       ? businessHoursBetween(clientContactTime, closedAt)       : null;

    const actions = await getLinkedActions(invId);
    const actionLabels = actions.flatMap(a => {
      const labels = a.labels||a.label_ids||[];
      return labels.map(l => {
        const id = typeof l==="object" ? (l.id||l.label_id) : l;
        return CONFIG.resolutionLabels[id] || null;
      }).filter(Boolean);
    });
    const resolution = actionLabels.find(l=>l!=="Warranty Call Out") || null;
    const warranty   = actionLabels.includes("Warranty Call Out");

    return { id:invId, title:inv.title||callReference||"Investigation", fault:faultType, contactMethod,
             status:isClosed?"Closed":"Open", clientContactTime, issueCreatedAt, createdAt, closedAt,
             responseHrs, resolutionHrs, resolution, warranty, office:matchOffice(siteName), room:siteName, callReference };
  }));

  // Inspections for HCV
  const allInsp = await pullPaged(`/feed/inspections?modified_after=${encodeURIComponent(CONFIG.reportStartDate)}`).catch(()=>[]);
  const sitesRaw = await pullPaged("/feed/sites").catch(()=>[]);
  const siteMap = {};
  sitesRaw.forEach(s=>{ siteMap[pick(s,["id","site_id"])] = pick(s,["name","site_name"])||"—"; });

  const hcvRows = allInsp
    .filter(i=>pick(i,["template_id","templateId"])===CONFIG.healthCheckTemplateId)
    .map(i=>({
      ref:(pick(i,["audit_id","inspection_id","id"])||"").toString().slice(-8),
      room:siteMap[pick(i,["site_id","site"])]||"—",
      status:pick(i,["date_completed","completed_at"])?"Completed":"In Progress",
      scheduled:pick(i,["created_at","date_started"]), completed:pick(i,["date_completed","completed_at"]),
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
             status, scheduled:scheduledRaw||null, completed:completed||null, outcome, siteName:siteLbl };
  }));

  const officeHCVSummary = CONFIG.offices.map(o => {
    const visits=officeHCVRaw.filter(h=>h.office===o);
    const v1=visits.find(h=>h.visitNum===1)||null, v2=visits.find(h=>h.visitNum===2)||null;
    const mkSlot=v=>v?{status:v.status,scheduled:v.scheduled,completed:v.completed,outcome:v.outcome}:{status:"Not scheduled",scheduled:null,completed:null,outcome:null};
    return {office:o,visit1:mkSlot(v1),visit2:mkSlot(v2)};
  });

  const report = computeMetrics(cases, hcvRows, officeHCVSummary, reportingMonthKey);
  report.meta.mode = "live";
  report.improvements = improvements;
  report.meta.connection = { investigationsPulled:rawInv.length, casesInPeriod:cases.length, inspectionsPulled:allInsp.length, officeHCVPulled:officeHCVInsp.length };
  return report;
}

/* ---------------------------------------------------------------- metrics */
function computeMetrics(cases, hcvRows, officeHCVSummary=[], reportingMonthKey=null) {
  const months = last6Months();
  const curKey = reportingMonthKey || months[months.length-2].key;
  const curMonth = months.find(m=>m.key===curKey)||months[months.length-2];
  const t = CONFIG.targets;
  const closed = cases.filter(c=>c.status==="Closed"&&c.closedAt);
  const open   = cases.filter(c=>c.status==="Open");
  const slaClosed = closed.filter(c=>!c.warranty);

  const trendLoggedClosed = months.map(m=>({
    month:m.label,
    logged:cases.filter(c=>mKey(c.createdAt)===m.key).length,
    closed:closed.filter(c=>mKey(c.closedAt)===m.key).length,
  }));

  const slaByCategory = FAULTS.map(f=>{
    const cc=slaClosed.filter(c=>c.fault===f&&c.responseHrs!=null);
    const avg=cc.length?cc.reduce((s,c)=>s+c.responseHrs,0)/cc.length:0;
    return {fault:f,avg:+avg.toFixed(2),target:t[f],within:cc.length?avg<=t[f]:true,count:cc.length};
  });

  const slaResolution = FAULTS.map(f=>{
    const cc=slaClosed.filter(c=>c.fault===f&&c.resolutionHrs!=null);
    const avg=cc.length?cc.reduce((s,c)=>s+c.resolutionHrs,0)/cc.length:0;
    return {fault:f,avg:+avg.toFixed(2),target:t[f],within:cc.length?avg<=t[f]:true,count:cc.length};
  });

  const slaTrend = months.map(m=>{
    const row={month:m.label};
    FAULTS.forEach(f=>{
      const cc=slaClosed.filter(c=>c.fault===f&&mKey(c.closedAt)===m.key&&c.responseHrs!=null);
      row[f]=cc.length?+(cc.reduce((s,c)=>s+c.responseHrs,0)/cc.length).toFixed(2):null;
    });
    return row;
  });

  const breachedCases = slaClosed
    .filter(c=>c.responseHrs!=null&&c.responseHrs>t[c.fault])
    .map(c=>({title:c.title,fault:c.fault,room:c.room,office:c.office,
               callReference:c.callReference,contactMethod:c.contactMethod,
               hrs:c.responseHrs,target:t[c.fault],over:+(c.responseHrs-t[c.fault]).toFixed(2),closed:c.closedAt}))
    .sort((a,b)=>b.over-a.over).slice(0,20);

  const roomCount={};
  slaClosed.forEach(c=>{roomCount[c.room]=(roomCount[c.room]||0)+1;});
  const topRooms=Object.entries(roomCount).sort((a,b)=>b[1]-a[1]).slice(0,7).map(([name,value])=>({name,value}));
  const topRoomNames=topRooms.slice(0,5).map(r=>r.name);
  const roomTrend=months.map(m=>{const row={month:m.label};topRoomNames.forEach(r=>{row[r]=slaClosed.filter(c=>c.room===r&&mKey(c.closedAt)===m.key).length;});return row;});

  const resCount={};
  slaClosed.forEach(c=>{const r=c.resolution||"Not recorded";resCount[r]=(resCount[r]||0)+1;});
  const byResolution=Object.entries(resCount).sort((a,b)=>b[1]-a[1]).map(([name,value])=>({name,value}));
  const topResNames=byResolution.slice(0,5).map(r=>r.name);
  const resTrend=months.map(m=>{const row={month:m.label};topResNames.forEach(r=>{row[r]=slaClosed.filter(c=>(c.resolution||"Not recorded")===r&&mKey(c.closedAt)===m.key).length;});return row;});

  const officeUsage={}, warrantyByOffice={};
  cases.forEach(c=>{
    if(c.warranty) warrantyByOffice[c.office]=(warrantyByOffice[c.office]||0)+1;
    else officeUsage[c.office]=(officeUsage[c.office]||0)+1;
  });
  const allOffices=new Set([...CONFIG.offices,...Object.keys(officeUsage)]);
  const officeAllocations=[...allOffices].map(o=>{
    const used=officeUsage[o]||0,alloc=CONFIG.callOutAllocation[o]||1;
    const pct=+(used/alloc*100).toFixed(1);
    return {office:o,alloc,used,remaining:alloc-used,pct,rag:pct>=90?"red":pct>=60?"amber":"green",warranty:warrantyByOffice[o]||0};
  }).sort((a,b)=>b.pct-a.pct);

  const curCases=cases.filter(c=>mKey(c.createdAt)===curKey);
  const curClosed=slaClosed.filter(c=>mKey(c.closedAt)===curKey);
  const openCases=open.map(c=>({
    title:c.title,fault:c.fault,room:c.room,office:c.office,
    contactMethod:c.contactMethod,callReference:c.callReference,
    created:c.createdAt,
    ageHrs:c.clientContactTime?businessHoursBetween(c.clientContactTime,now().toISOString()):null,
    warranty:c.warranty||false,
  }));

  const openByCategory={};
  FAULTS.forEach(f=>{openByCategory[f]=open.filter(c=>c.fault===f&&!c.warranty).length;});
  const roomDownBreaches=open.filter(c=>!c.warranty&&c.fault==="Room Down"&&
    c.clientContactTime&&businessHoursBetween(c.clientContactTime,now().toISOString())>t["Room Down"]).length;

  const byContactMethod={
    email:cases.filter(c=>c.contactMethod==="Email").length,
    phone:cases.filter(c=>c.contactMethod==="Phone Call").length,
  };

  const expectedTotal=CONFIG.offices.length*CONFIG.visitsPerOfficePerYear;
  const allVisitSlots=officeHCVSummary.flatMap(o=>[o.visit1,o.visit2]);

  return {
    meta:{mode:"sample",generatedAt:now().toISOString(),company:CONFIG.companyName,
          monthsLabels:months.map(m=>m.label),monthsKeys:months.map(m=>m.key),
          reportingMonth:curKey,reportingMonthLabel:curMonth.label,slaRef:"TECHPR-0510"},
    targets:t, responseTargets:CONFIG.responseTargets, callOutAllocationTotal:TOTAL_CALLOUT_ALLOC,
    kpis:{loggedThisMonth:curCases.length,closedThisMonth:curClosed.length,openNow:open.length,roomDownBreaches},
    warrantyThisMonth:curCases.filter(c=>c.warranty).length,
    warrantyThisMonthCases:curCases.filter(c=>c.warranty).map(c=>({title:c.title,fault:c.fault,room:c.room,created:c.createdAt,status:c.status,warranty:true})),
    byContactMethod, openByCategory, roomDownBreaches,
    trendLoggedClosed, slaByCategory, slaResolution, slaTrend, breachedCases,
    topRooms, topRoomNames, roomTrend, byResolution, topResNames, resTrend,
    serviceCalls:{month:curCases.length,sixMonth:cases.length,
      trend:months.map(m=>({month:m.label,visits:cases.filter(c=>mKey(c.createdAt)===m.key).length}))},
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
    loggedThisMonthCases:curCases.map(c=>({title:c.title,fault:c.fault,room:c.room,created:c.createdAt,status:c.status,warranty:c.warranty||false,callReference:c.callReference,contactMethod:c.contactMethod})),
    closedThisMonthCases:curClosed.map(c=>({title:c.title,fault:c.fault,room:c.room,closed:c.closedAt,resolution:c.resolution,warranty:false,callReference:c.callReference,responseHrs:c.responseHrs,resolutionHrs:c.resolutionHrs})),
    openCases, improvements,
  };
}

/* ---------------------------------------------------------------- sample */
function buildSampleReport(reportingMonthKey=null) {
  const months=last6Months();
  const roomDefs=[
    {room:"Leeds - Ryder",office:"Leeds"},{room:"Leeds - The Exchange",office:"Leeds"},
    {room:"Birmingham - Colmore",office:"Birmingham"},{room:"Manchester - Hardman",office:"Manchester"},
    {room:"London - Finsbury",office:"London"},{room:"Bristol - Glass Wharf",office:"Bristol"},
  ];
  const cases=[];
  months.forEach((m,mi)=>{
    const n=[4,6,5,4,7,2][mi]||5;
    for (let i=0;i<n;i++) {
      const fault=i%7===0?"Room Down":i%2?"Partial Fault":"Routine";
      const [y,mo]=m.key.split("-");
      const cc=new Date(+y,+mo-1,2+(i*2)%25,8+(i%3));
      const delay=0.3+(i%4)*0.4;
      const ic=new Date(cc.getTime()+delay*36e5);
      const isOpen=mi===5&&i%5===0;
      const tgt=fault==="Room Down"?8:fault==="Partial Fault"?24:120;
      const resH=i%6===0?tgt*1.8:tgt*(0.2+(i%4)*0.1);
      const closedAt=isOpen?null:new Date(cc.getTime()+resH*36e5);
      const rd=roomDefs[(mi*3+i)%roomDefs.length];
      cases.push({
        id:`s-${mi}-${i}`,title:`Case ${i+1}`,fault,
        contactMethod:i%3===0?"Phone Call":"Email",
        status:isOpen?"Open":"Closed",
        clientContactTime:cc.toISOString(),
        issueCreatedAt:ic.toISOString(),
        createdAt:ic.toISOString(),
        closedAt:closedAt?.toISOString()||null,
        responseHrs:isOpen?null:+delay.toFixed(2),
        resolutionHrs:isOpen?null:+(businessHoursBetween(cc.toISOString(),closedAt?.toISOString()||null)||0).toFixed(2),
        resolution:isOpen?null:["Re-Configuration","Hardware Replacement","Re-Cabling","No Fault Found","Consumable"][i%5],
        warranty:false,office:rd.office,room:rd.room,callReference:`GT-${2570000+mi*100+i}`,
      });
    }
  });

  const hcvRows=[
    {ref:"HCV-001",room:"Event Rooms (Leeds)",status:"Completed",scheduled:"2025-09-15",completed:"2025-12-19"},
    {ref:"HCV-002",room:"Event Rooms (London)",status:"In Progress",scheduled:"2025-11-01",completed:null},
  ];

  const sampleStatuses=[
    ["Completed","Booked"],["Booked","Not scheduled"],["Not scheduled","Not scheduled"],
    ["Completed","Completed"],["Overdue","Not scheduled"],["Booked","Not scheduled"],
    ["Not scheduled","Not scheduled"],["Completed","Booked"],["Overdue","Booked"],
    ["Not scheduled","Not scheduled"],["Booked","Not scheduled"],["Completed","Not scheduled"],
    ["Not scheduled","Not scheduled"],["Booked","Not scheduled"],["Completed","Booked"],
    ["Overdue","Not scheduled"],["Not scheduled","Not scheduled"],
  ];
  const mkDate=d=>new Date(now().getTime()+d*864e5).toISOString();
  const officeHCVSummary=CONFIG.offices.map((o,i)=>{
    const [s1,s2]=sampleStatuses[i]||["Not scheduled","Not scheduled"];
    const mkV=s=>({status:s,outcome:s==="Completed"?(i%3===0?"Minor Issues":"All Good"):null,
      scheduled:s==="Not scheduled"?null:s==="Completed"?mkDate(-60):s==="Overdue"?mkDate(-5):mkDate(30),
      completed:s==="Completed"?mkDate(-45):null});
    return {office:o,visit1:mkV(s1),visit2:mkV(s2)};
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

app.get("/api/debug-investigation", async (req,res)=>{
  try { res.json(await scFetch("/investigations/v1/investigations/ea8833e4-82ee-41cc-9ee2-37809530a7c9")); }
  catch(e){ res.json({error:e.message}); }
});

app.get("/api/improvements",        (req,res)=>res.json(improvements));
app.post("/api/improvements",       (req,res)=>{ const item={...req.body,id:"imp-"+Date.now()}; improvements.push(item); saveImprovements(improvements); res.json(item); });
app.put("/api/improvements/:id",    (req,res)=>{ const idx=improvements.findIndex(i=>i.id===req.params.id); if(idx===-1)return res.status(404).json({error:"Not found"}); improvements[idx]={...improvements[idx],...req.body}; saveImprovements(improvements); res.json(improvements[idx]); });
app.delete("/api/improvements/:id", (req,res)=>{ improvements=improvements.filter(i=>i.id!==req.params.id); saveImprovements(improvements); res.json({ok:true}); });

app.get("/api/debug-inv-list", async (req,res)=>{
  try {
    const j = await scFetch(`/investigations/v1/investigations?categoryId=${CONFIG.investigationCategoryId}`);
    res.json({ raw: j, keys: Object.keys(j) });
  } catch(e){ res.json({error:e.message}); }
});

app.use(express.static(path.join(__dirname,"public")));
app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));

app.listen(PORT,()=>console.log(`AV Dashboard on port ${PORT} — ${SC_TOKEN?"LIVE":"SAMPLE DATA"}`));
