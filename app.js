// ------------------------------
// PDF.js setup
// ------------------------------
pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

// ------------------------------
// Utilities
// ------------------------------
function clamp(n, min, max){ return Math.max(min, Math.min(max, n)); }
function fmtPct(x){ return (x==null || isNaN(x)) ? "—" : `${x.toFixed(1)}%`; }
function fmtInt(x){ return (x==null || isNaN(x)) ? "—" : `${Math.round(x).toLocaleString()}`; }
function fmtMoney(x){
  if(x==null || isNaN(x)) return "—";
  const sign = x < 0 ? "-" : "";
  const v = Math.abs(x);
  return `${sign}$${v.toLocaleString(undefined,{maximumFractionDigits:0})}`;
}
function escapeHtml(s){
  return (s||"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
}
function showErr(msg){ const e=document.getElementById("errbar"); e.style.display="block"; e.innerHTML = msg; }
function clearErr(){ const e=document.getElementById("errbar"); e.style.display="none"; e.innerHTML = ""; }
function showOk(msg){ const o=document.getElementById("okbar"); o.style.display="block"; o.innerHTML = msg; }

// ------------------------------
// State
// ------------------------------
const state = {
  docs: [], // {name,type,pages,textByPage[]}
  evidence: [], // {disparity, snippet, doc, page}
  findings: [], // Tier1: {id,key,disparity,segment,magnitude,prominence,concentration,score,recommend,evidenceRef}
  opportunities: [], // Tier2: {opp,kind,tests,criterion,strength,score,scope,checklist}
  selectedOpp: null,
  transport: {overall:null, age6574:null},
  chnaEval: [], // per-doc CHNA/IS documentation + community input requirement checks
  model: null // Tier 3 scenario cache for draft generator
};

// Disparities list (includes transportation explicitly)
const DISPARITIES = [
  {key:"transport", label:"Transportation barrier", keywords:["transportation","transit"], metric:"% reporting transportation problems"},
  {key:"access", label:"Access to care barrier", keywords:["could not get an appointment","delayed care"], metric:"% delaying needed care"},
  {key:"food", label:"Food insecurity", keywords:["food insecurity","food shelf"], metric:"% reporting food insecurity"},
  {key:"housing", label:"Housing need", keywords:["housing needs","housing"], metric:"% reporting housing needs"},
  {key:"financial", label:"Financial need", keywords:["financial needs","cost too much"], metric:"% reporting financial needs"}
];

// CRA criteria mapping (explicit criterion satisfied)
// Note: This is written in a regulator-friendly way, citing the OCC illustrative list structure (Topic L — community support services).
const CRA_CRITERIA = {
  nmt: {
    criterion: "Community development services / community support services targeted to low- or moderate-income (LMI) individuals — transportation to medical treatments.",
    cite: "Qualifying Activities: 12 CFR 25.04(c)(3) Topic L (Community support services) — example: transportation to medical treatments for LMI individuals."
  },
  food: {
    criterion: "Community development services / community support services targeted to LMI individuals — food access support as a community service (when structured for LMI populations).",
    cite: "Qualifying Activities: 12 CFR 25.04(c)(3) Topic L (Community support services) — community services for LMI individuals (structure matters)."
  },
  care: {
    criterion: "Community development services targeted to LMI individuals — health services / community services that improve access (depending on structure and beneficiaries).",
    cite: "Qualifying Activities: 12 CFR 25.04(c)(3) Topic L (Community support services) — health/community services for LMI individuals (structure matters)."
  }
};

// ------------------------------
// Extraction
// ------------------------------
async function extractPdfText(file){
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({data: arrayBuffer}).promise;
  const numPages = pdf.numPages;
  const textByPage = [];
  for(let p=1; p<=numPages; p++){
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const strings = content.items.map(it => it.str).filter(Boolean);
    const text = strings.join(" ").replace(/\s+/g,' ').trim();
    textByPage.push(text);
  }
  return {pages: numPages, textByPage};
}
async function extractTxt(file){
  const text = await file.text();
  return {pages: 1, textByPage: [text.replace(/\s+/g,' ').trim()]};
}

function recordEvidence(disparityLabel, snippet, doc, page){
  state.evidence.push({disparity:disparityLabel, snippet, doc, page});
}

function findPercentNear(text, keyword){
  const re = new RegExp(`${keyword}[\\s\\S]{0,160}?(\\d{1,2}(?:\\.\\d+)?)%`, "i");
  const m = text.match(re);
  if(!m) return null;
  const val = parseFloat(m[1]);
  if(isNaN(val)) return null;
  return {val, snippet: m[0].slice(0,280)};
}
function findAge6574Transport(text){
  const re = /65\s*[-–]\s*74[\s\S]{0,160}transportation[\s\S]{0,80}?(\d{1,2}(?:\.\d+)?)%/i;
  const m = text.match(re);
  if(!m) return null;
  const val = parseFloat(m[1]);
  if(isNaN(val)) return null;
  return {val, snippet: m[0].slice(0,280)};
}

function addFinding(key, disparity, segment, magnitude, prominence, evidenceRef){
  const id = `${key}__${segment}`;
  const ex = state.findings.find(x=>x.id===id);
  if(ex){
    if(magnitude > ex.magnitude){
      ex.magnitude = magnitude;
      ex.prominence = Math.max(ex.prominence, prominence);
      ex.evidenceRef = evidenceRef;
    }
    return;
  }
  state.findings.push({
    id, key, disparity, segment, magnitude,
    prominence,
    concentration:0,
    score:0,
    recommend:"",
    evidenceRef
  });
}

function scanDoc(doc){
  const prominence = {};
  for(const d of DISPARITIES){ prominence[d.key]=0; }

  for(let i=0;i<doc.textByPage.length;i++){
    const t = doc.textByPage[i] || "";
    const lower = t.toLowerCase();

    // prominence by keywords
    for(const d of DISPARITIES){
      for(const kw of d.keywords){
        if(lower.includes(kw.toLowerCase())){ prominence[d.key] += 1; break; }
      }
    }

    // Transportation overall
    const tr = findPercentNear(t, "transportation");
    if(tr){
      recordEvidence("Transportation barrier", tr.snippet, doc.name, i+1);
      addFinding("transport", "Transportation barrier", "Overall", tr.val, prominence["transport"], `${doc.name} p.${i+1}`);
      if(state.transport.overall==null) state.transport.overall = tr.val;
    }
    // Transportation 65-74
    const tr6574 = findAge6574Transport(t);
    if(tr6574){
      recordEvidence("Transportation barrier", tr6574.snippet, doc.name, i+1);
      addFinding("transport", "Transportation barrier", "Age 65–74", tr6574.val, prominence["transport"], `${doc.name} p.${i+1}`);
      state.transport.age6574 = tr6574.val;
    }

    // Other disparities
    for(const d of DISPARITIES){
      if(d.key==="transport") continue;
      const primary = d.keywords[0];
      const p = findPercentNear(t, primary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      if(p){
        recordEvidence(d.label, p.snippet, doc.name, i+1);
        addFinding(d.key, d.label, "Overall", p.val, prominence[d.key], `${doc.name} p.${i+1}`);
      }
    }
  }
}


// ------------------------------
// Tier 1 enhancement: CHNA/IS documentation + community input requirement gap checks
// Based on common IRS documentation elements assessed in the literature and the 3-part written comments requirement.
// - CHNA documentation elements (7): community definition; methods; input from community; underserved populations described; prioritized needs; resources available; evaluation of impact.
// - Implementation strategy elements (3): actions for each need; resources and anticipated impact; planned collaborations.
// - Written comments requirement (3): solicitation method; ≥1 written comment received; explanation of how comments were taken into account.
// These checks are heuristic (keyword-based) and intended to speed a gap analysis / remediation workflow.
const CHNA_ELEMENTS = [
  {id:"community_def", label:"Definition of community served + how determined", pats:["definition of the community","community served","service area","community definition","how the community was determined"]},
  {id:"methods", label:"Process and methods used to conduct CHNA", pats:["methods","methodology","data sources","process used","approach","survey methodology","focus group"]},
  {id:"input", label:"How input was solicited and taken into account (broad interests)", pats:["input from persons who represent","broad interests of the community","community input","stakeholder input","community representatives"]},
  {id:"underserved", label:"Description of medically underserved / low-income / minority populations represented by input", pats:["medically underserved","low-income","minority populations","priority populations","vulnerable populations","underserved populations"]},
  {id:"priorities", label:"Prioritized description of significant health needs", pats:["prioritized","priority health needs","significant health needs","ranked","top needs","prioritization"]},
  {id:"resources", label:"Resources potentially available to address identified needs", pats:["resources available","available resources","community resources","assets","existing programs","capacity"]},
  {id:"impact_eval", label:"Evaluation of impact since the immediately preceding CHNA", pats:["evaluation of impact","impact of actions","progress since","results since last","prior CHNA","evaluation since"]},
];

const IS_ELEMENTS = [
  {id:"is_actions", label:"Actions to address each health need", pats:["actions the hospital will take","strategy","interventions","action plan","will address"]},
  {id:"is_resources_impact", label:"Resources devoted + anticipated impact", pats:["resources devoted","anticipated impact","budget","investment","expected impact","metrics"]},
  {id:"is_collab", label:"Planned collaborations with other institutions", pats:["collaboration","partner","coalition","in partnership with","collaborate with","community partners"]},
];

const WRITTEN_COMMENT_ELEMENTS = [
  {id:"wc_solicit", label:"How written comments were solicited (most recent CHNA/IS)", pats:["written comments","public comment","comment period","solicit","feedback form","survey","web-based","paper survey","community forum","open house","telephone"]},
  {id:"wc_received", label:"At least 1 written comment received", pats:["we received","comments were received","comment(s) received","written comment","responses received","feedback received"]},
  {id:"wc_used", label:"How comments were taken into account in current CHNA/IS", pats:["taken into account","incorporated","informed","used to update","we considered","resulting changes","we adjusted","we revised"]},
];

function _findSnippet(text, pat){
  const idx = text.toLowerCase().indexOf(pat.toLowerCase());
  if(idx < 0) return null;
  const start = Math.max(0, idx-90);
  const end = Math.min(text.length, idx+170);
  return text.slice(start,end).replace(/\s+/g,' ').trim();
}

function evalDocForElements(doc){
  const all = (doc.textByPage||[]).join(" \n");
  const lower = all.toLowerCase();

  const isCHNA = lower.includes("community health needs assessment") || lower.includes("chna");
  const isIS = lower.includes("implementation strategy") || lower.includes("implementation plan") || lower.includes("implementation strategies");

  // Public availability signal (heuristic)
  const publicPats = ["available on our website","posted on our website","publicly available","public comment","comment period","available online"];
  const publicHit = publicPats.find(p=>lower.includes(p.toLowerCase()));
  const publicSnippet = publicHit ? _findSnippet(all, publicHit) : null;

  function scoreBlock(block){
    let hits = [];
    for(const el of block){
      let found = null;
      for(const p of el.pats){
        if(lower.includes(p.toLowerCase())){ found = p; break; }
      }
      const snippet = found ? _findSnippet(all, found) : null;
      hits.push({id:el.id, label:el.label, present: !!found, trigger: found || "", snippet: snippet || ""});
    }
    const presentCount = hits.filter(h=>h.present).length;
    const score = Math.round((presentCount / hits.length) * 100);
    return {score, hits, presentCount, total:hits.length};
  }

  const chna = scoreBlock(CHNA_ELEMENTS);
  const isb = scoreBlock(IS_ELEMENTS);
  const wc = scoreBlock(WRITTEN_COMMENT_ELEMENTS);

  const wcScore = wc.presentCount===3 ? 100 : (wc.presentCount===2 ? 67 : (wc.presentCount===1 ? 33 : 0));
  const publicScore = publicHit ? 100 : 0;

  return {
    doc: doc.name,
    isCHNA, isIS,
    chnaScore: chna.score,
    isScore: isb.score,
    writtenCommentsScore: wcScore,
    publicScore,
    chnaHits: chna.hits,
    isHits: isb.hits,
    wcHits: wc.hits,
    publicSnippet: publicSnippet || ""
  };
}

function renderChnaGaps(){
  const tbl = document.getElementById("tbl_chna_gaps");
  if(!tbl) return;

  if(!state.chnaEval || state.chnaEval.length===0){
    tbl.innerHTML = "<tr><th>Document</th><th>CHNA score</th><th>IS score</th><th>Written comments</th><th>Public availability</th><th>Top gaps (auto)</th><th>Evidence</th></tr><tr><td colspan='7'>Process documents to populate.</td></tr>";
    const rec = document.getElementById("chna_gap_recs");
    if(rec) rec.textContent = "Process documents to generate.";
    document.getElementById("kpi_chna_q").textContent = "—";
    document.getElementById("kpi_is_q").textContent = "—";
    document.getElementById("kpi_input_req").textContent = "—";
    document.getElementById("kpi_public_avail").textContent = "—";
    return;
  }

  // Aggregate KPIs across docs (take max score across docs, since some uploads may be partial excerpts)
  const chnaMax = Math.max(...state.chnaEval.map(x=>x.chnaScore||0));
  const isMax = Math.max(...state.chnaEval.map(x=>x.isScore||0));
  const wcMax = Math.max(...state.chnaEval.map(x=>x.writtenCommentsScore||0));
  const pubMax = Math.max(...state.chnaEval.map(x=>x.publicScore||0));

  document.getElementById("kpi_chna_q").textContent = chnaMax + "/100";
  document.getElementById("kpi_is_q").textContent = isMax + "/100";
  document.getElementById("kpi_input_req").textContent = wcMax===100 ? "Meets (3/3)" : (wcMax===67 ? "Partial (2/3)" : (wcMax===33 ? "Weak (1/3)" : "Missing (0/3)"));
  document.getElementById("kpi_public_avail").textContent = pubMax===100 ? "Detected" : "Not detected";

  let html = "<tr><th>Document</th><th>CHNA score</th><th>IS score</th><th>Written comments</th><th>Public availability</th><th>Top gaps (auto)</th><th>Evidence</th></tr>";
  const gapsAll = [];
  for(const d of state.chnaEval){
    const gaps = [];
    // pick top 3 gaps across blocks
    const miss = []
      .concat(d.chnaHits.filter(h=>!h.present).map(h=>({label:h.label, snippet:h.snippet})))
      .concat(d.isHits.filter(h=>!h.present).map(h=>({label:h.label, snippet:h.snippet})))
      .concat(d.wcHits.filter(h=>!h.present).map(h=>({label:h.label, snippet:h.snippet})));

    miss.slice(0,3).forEach(m=>gaps.push(m.label));
    gapsAll.push(...gaps);

    const ev = (d.publicSnippet ? `Public signal: ${d.publicSnippet}` : "") || (d.wcHits.find(h=>h.present && h.snippet)?.snippet || "") || (d.chnaHits.find(h=>h.present && h.snippet)?.snippet || "");
    html += `<tr>
      <td class="mono"><b>${escapeHtml(d.doc)}</b></td>
      <td class="mono">${d.isCHNA ? (d.chnaScore + "/100") : "—"}</td>
      <td class="mono">${d.isIS ? (d.isScore + "/100") : "—"}</td>
      <td>${d.writtenCommentsScore===100 ? '<span class="badge b-strong">Meets (3/3)</span>' : (d.writtenCommentsScore>=67 ? '<span class="badge b-mod">Partial</span>' : '<span class="badge b-weak">Gap</span>')}</td>
      <td>${d.publicScore===100 ? '<span class="badge b-strong">Detected</span>' : '<span class="badge b-weak">Not detected</span>'}</td>
      <td>${escapeHtml(gaps.join("; ") || "—")}</td>
      <td>${escapeHtml(ev || "—")}</td>
    </tr>`;
  }
  tbl.innerHTML = html;

  // Remediation recs
  const rec = [];
  const needsWritten = wcMax < 100;
  if(needsWritten){
    rec.push("Written comments compliance (3-part) is incomplete: add a documented solicitation method (paper + web + in-person options), confirm ≥1 written comment received, and explicitly state how comments changed priorities or strategies.");
  }
  if(chnaMax < 85){
    rec.push("CHNA documentation gaps detected: ensure the CHNA explicitly includes (a) community definition and how it was determined, (b) methods/data sources, (c) who provided input and which underserved populations they represent, (d) prioritized needs, (e) resources available, and (f) evaluation of impact since the prior CHNA.");
  }
  if(isMax < 85){
    rec.push("Implementation Strategy gaps detected: ensure the IS lists actions for each prioritized need, associated resources and anticipated impact, and planned collaborations/partners.");
  }
  if(pubMax < 100){
    rec.push("Public availability signal not detected in the uploaded excerpts: ensure the CHNA and IS are clearly posted online and the document states where/how the public can access them.");
  }
  rec.push("Operationalizing fix: add a one-page ‘CHNA/IS Compliance Addendum’ template with these elements, then paste into the CHNA and IS PDFs for audit-ready completeness.");

  const recEl = document.getElementById("chna_gap_recs");
  if(recEl) recEl.textContent = rec.join(" ");
}

function computeMateriality(){
  // Compute concentration per key (subgroup - overall)
  const byKey = {};
  for(const f of state.findings){
    if(!byKey[f.key]) byKey[f.key]=[];
    byKey[f.key].push(f);
  }
  for(const key of Object.keys(byKey)){
    const list = byKey[key];
    const overall = list.find(x=>x.segment==="Overall");
    for(const f of list){
      f.concentration = (f.segment!=="Overall" && overall) ? Math.max(0, f.magnitude - overall.magnitude) : 0;
    }
  }

  // Materiality score:
  // magnitude (0-60), concentration (0-25), prominence (0-15)
  // transportation amplification: if 65–74 exists and overall exists, add bonus up to +10
  let transportBonus = 0;
  if(state.transport.overall!=null && state.transport.age6574!=null && state.transport.overall>0){
    const amp = state.transport.age6574 / state.transport.overall;
    transportBonus = clamp((amp-1)*8, 0, 10); // up to 10 points bonus
  }

  for(const f of state.findings){
    const magScore = clamp((f.magnitude/30)*60, 0, 60);
    const concScore = clamp((f.concentration/15)*25, 0, 25);
    const promScore = clamp((f.prominence/6)*15, 0, 15);
    let score = Math.round(magScore + concScore + promScore);
    if(f.key==="transport") score = clamp(score + Math.round(transportBonus), 0, 100);
    f.score = score;
    f.recommend = (score>=70) ? "Advance (high)" : (score>=55 ? "Advance (moderate)" : "Defer/monitor");
  }
  state.findings.sort((a,b)=>b.score-a.score);
}

function buildOpportunities(){
  const bestByKey = {};
  for(const f of state.findings){
    if(!bestByKey[f.key]) bestByKey[f.key]=f;
  }

  // Always include transportation opportunity (requirement), score based on findings if present
  const opps = [];

  function scoreOpportunity(eligibilityClarity, responsiveness, attributionStrength, docBurden){
    return Math.round(0.30*eligibilityClarity + 0.30*responsiveness + 0.25*attributionStrength + 0.15*(100-docBurden));
  }

  // Attribution heuristic
  const attribution = 70; // default; can be enhanced later if we parse AA geos
  const scope = "Prefer AA attribution: document beneficiary location (ZIP/tract/county) and service delivery within AA; if broader, document proportional benefit.";

  // Transportation (NEMT) — explicit criterion
  {
    const f = bestByKey.transport || {score:55}; // keep it evaluable even if CHNA extraction fails
    const eligibility = 90; // strong
    const responsiveness = clamp(f.score, 0, 100);
    const burden = 35;
    const score = scoreOpportunity(eligibility, responsiveness, attribution, burden);
    opps.push({
      opp:"Transportation-to-care (NEMT) — missed appointment mitigation",
      kind:"nmt",
      tests:"Service • Investment (as structured) • CD Loans (as structured)",
      criterion: CRA_CRITERIA.nmt.criterion + " " + CRA_CRITERIA.nmt.cite,
      strength: score>=75 ? "Strong" : (score>=60 ? "Moderate" : "Weak"),
      score,
      scope,
      checklist:"CHNA excerpt(s) with overall + age-band differential; target population definition (LMI and/or qualifying segments); service area map; vendor/partner agreement; invoices; ride logs; beneficiary counts; monitoring report cadence."
    });
  }

  // Food
  if(bestByKey.food){
    const f = bestByKey.food;
    const eligibility = 80;
    const responsiveness = clamp(f.score,0,100);
    const burden = 45;
    const score = scoreOpportunity(eligibility, responsiveness, attribution, burden);
    opps.push({
      opp:"Food access support — distribution / vouchers / meal supports",
      kind:"food",
      tests:"Investment • Service (depending on structure)",
      criterion: CRA_CRITERIA.food.criterion + " " + CRA_CRITERIA.food.cite,
      strength: score>=75 ? "Strong" : (score>=60 ? "Moderate" : "Weak"),
      score,
      scope,
      checklist:"CHNA food measure; LMI targeting method; partner agreement; distribution logs; invoices; beneficiary counts; monitoring plan."
    });
  }

  // Access
  if(bestByKey.access){
    const f = bestByKey.access;
    const eligibility = 75;
    const responsiveness = clamp(f.score,0,100);
    const burden = 50;
    const score = scoreOpportunity(eligibility, responsiveness, attribution, burden);
    opps.push({
      opp:"Care navigation / referral infrastructure — access enablement",
      kind:"care",
      tests:"Service • Investment (as structured)",
      criterion: CRA_CRITERIA.care.criterion + " " + CRA_CRITERIA.care.cite,
      strength: score>=75 ? "Strong" : (score>=60 ? "Moderate" : "Weak"),
      score,
      scope,
      checklist:"CHNA access barrier evidence; workflow description; staffing records; referral counts; LMI targeting; monitoring plan."
    });
  }

  opps.sort((a,b)=>b.score-a.score);
  state.opportunities = opps;
  state.selectedOpp = opps.length ? opps[0] : null;
}

function tier3Unlocked(){
  return state.opportunities.some(o=>o.score>=60);
}

// ------------------------------
// Rendering
// ------------------------------
let chartMateriality=null, chartROI=null, chartTrend=null;

function strengthBadge(str){
  if(str==="Strong") return `<span class="badge b-strong">Strong</span>`;
  if(str==="Moderate") return `<span class="badge b-mod">Moderate</span>`;
  return `<span class="badge b-weak">Weak</span>`;
}

function renderTransportSpotlight(){
  const o = state.transport.overall;
  const a = state.transport.age6574;
  document.getElementById("t_overall").textContent = (o==null) ? "—" : fmtPct(o);
  document.getElementById("t_6574").textContent = (a==null) ? "—" : fmtPct(a);
  if(o!=null && a!=null && o>0){
    const amp = a/o;
    document.getElementById("t_amp").textContent = `${amp.toFixed(1)}×`;
  }else{
    document.getElementById("t_amp").textContent = "—";
  }
}

function renderTier1(){
  // KPIs
  if(state.findings.length){
    const top = state.findings[0];
    document.getElementById("kpi_top").textContent = `${top.disparity} (${top.score})`;
    document.getElementById("kpi_top_hint").textContent = `Magnitude ${fmtPct(top.magnitude)} • Prominence ${top.prominence} • Δ ${top.concentration.toFixed(1)}.`;
    const subs = state.findings.filter(x=>x.segment!=="Overall").sort((a,b)=>b.concentration-a.concentration);
    if(subs.length){
      const s = subs[0];
      document.getElementById("kpi_conc").textContent = `${s.disparity} Δ${s.concentration.toFixed(1)}% (${s.segment})`;
    }else{
      document.getElementById("kpi_conc").textContent = "—";
    }
    const shortlist = state.findings.filter(f=>f.score>=55).length;
    document.getElementById("kpi_shortlist").textContent = `${shortlist}`;
    const angle = (state.transport.overall!=null && state.transport.age6574!=null) ?
      "Transportation appears small overall, but materially higher in older adults — strong case for targeted NEMT." :
      "Use highest materiality disparities to form a joint bank–hospital decision memo.";
    document.getElementById("kpi_angle").textContent = angle;
  }

  // Materiality table
  const tbl = document.getElementById("tbl_materiality");
  if(!state.findings.length){
    tbl.innerHTML = "<tr><th>Disparity</th><th>Segment</th><th>Magnitude</th><th>Δ Concentration</th><th>Prominence</th><th>Score</th><th>Recommendation</th><th>Evidence</th></tr><tr><td colspan='8'>No results yet.</td></tr>";
  }else{
    let html = "<tr><th>Disparity</th><th>Segment</th><th>Magnitude</th><th>Δ Concentration</th><th>Prominence</th><th>Score</th><th>Recommendation</th><th>Evidence</th></tr>";
    for(const f of state.findings.slice(0,10)){
      html += `<tr>
        <td><b>${escapeHtml(f.disparity)}</b></td>
        <td>${escapeHtml(f.segment)}</td>
        <td class="mono">${fmtPct(f.magnitude)}</td>
        <td class="mono">${f.concentration.toFixed(1)}%</td>
        <td class="mono">${f.prominence}</td>
        <td class="mono"><b>${f.score}</b></td>
        <td>${escapeHtml(f.recommend)}</td>
        <td class="mono">${escapeHtml(f.evidenceRef||"—")}</td>
      </tr>`;
    }
    tbl.innerHTML = html;
  }

  // Materiality chart
  const top = state.findings.slice(0,8);
  const labels = top.map(f=>`${f.disparity}${f.segment!=="Overall" ? " ("+f.segment+")" : ""}`);
  const vals = top.map(f=>f.score);
  if(chartMateriality) chartMateriality.destroy();
  chartMateriality = new Chart(document.getElementById("chart_materiality"), {
    type:"bar",
    data:{labels, datasets:[{label:"Materiality (0–100)", data:vals}]},
    options:{
      plugins:{legend:{display:false}},
      scales:{
        x:{ticks:{color:"#2f4556"}, grid:{color:"rgba(11,31,51,.08)"}},
        y:{ticks:{color:"#2f4556"}, grid:{color:"rgba(11,31,51,.08)"}, beginAtZero:true, max:100}
      }
    }
  });

  // Tier 1 recs
  const rec = [];
  if(state.transport.overall!=null && state.transport.age6574!=null){
    rec.push(`Transportation: overall ${fmtPct(state.transport.overall)} vs age 65–74 ${fmtPct(state.transport.age6574)} (amplification ${(state.transport.age6574/state.transport.overall).toFixed(1)}×). Treat as a high-value access lever (missed appointments).`);
  }
  const adv = state.findings.filter(f=>f.score>=70).slice(0,3);
  if(adv.length){
    rec.push(`Advance now: ${adv.map(x=>x.disparity).join(", ")}.`);
  }else{
    rec.push("Advance now: highest scoring disparity and validate geography + target segment in Tier 2.");
  }
  rec.push("Create a joint bank–hospital memo: (1) documented need, (2) target segment/geography, (3) CRA criterion satisfied, (4) documentation plan, (5) cost baseline and KPI monitoring.");
  document.getElementById("tier1_recs").textContent = rec.join(" ");

  // Tier 1 enhancement: CHNA/IS gap analysis
  if(typeof renderChnaGaps === "function") renderChnaGaps();
}

function renderEvidence(){
  const tbl = document.getElementById("tbl_evidence");
  if(!state.evidence.length){
    tbl.innerHTML = "<tr><th>Disparity</th><th>Snippet</th><th>Doc</th><th>Page</th></tr><tr><td colspan='4'>No evidence captured yet.</td></tr>";
    return;
  }
  const slice = state.evidence.slice(-25).reverse();
  let html = "<tr><th>Disparity</th><th>Snippet</th><th>Doc</th><th>Page</th></tr>";
  for(const e of slice){
    html += `<tr>
      <td>${escapeHtml(e.disparity)}</td>
      <td>${escapeHtml(e.snippet)}</td>
      <td class="mono">${escapeHtml(e.doc)}</td>
      <td class="mono">${e.page}</td>
    </tr>`;
  }
  tbl.innerHTML = html;
}

function renderTier2(){
  const tbl = document.getElementById("tbl_cra");
  if(!state.opportunities.length){
    tbl.innerHTML = "<tr><th>Opportunity</th><th>CRA test mapping</th><th>Criterion satisfied</th><th>Strength</th><th>Score</th><th>Scope guidance</th><th>Application packet checklist</th></tr><tr><td colspan='7'>No opportunities yet.</td></tr>";
    return;
  }
  let html = "<tr><th>Opportunity</th><th>CRA test mapping</th><th>Criterion satisfied</th><th>Strength</th><th>Score</th><th>Scope guidance</th><th>Application packet checklist</th></tr>";
  for(const o of state.opportunities){
    html += `<tr>
      <td><b>${escapeHtml(o.opp)}</b></td>
      <td>${escapeHtml(o.tests)}</td>
      <td>${escapeHtml(o.criterion)}</td>
      <td>${strengthBadge(o.strength)}</td>
      <td class="mono"><b>${o.score}</b></td>
      <td>${escapeHtml(o.scope)}</td>
      <td>${escapeHtml(o.checklist)}</td>
    </tr>`;
  }
  tbl.innerHTML = html;

  const top = state.opportunities[0];
  document.getElementById("t2_best").textContent = `${top.score}`;
  document.getElementById("t2_best_hint").textContent = top.opp;

  const tOpp = state.opportunities.find(x=>x.kind==="nmt");
  document.getElementById("t2_transport").textContent = tOpp ? `${tOpp.score} (${tOpp.strength})` : "—";
  document.getElementById("t2_crit").textContent = tOpp ? tOpp.criterion : "—";
  document.getElementById("t2_packet").textContent = tOpp ? "CHNA evidence + LMI targeting + AA attribution + invoices + service logs + beneficiary counts + monitoring" : "—";

  document.getElementById("top_t2").textContent = `${top.score}`;

  // Gate
  const unlocked = tier3Unlocked();
  const dot = document.getElementById("gateDot");
  dot.classList.remove("good","bad");
  if(unlocked){ dot.classList.add("good"); document.getElementById("gateText").textContent = "Tier 3 unlocked (Tier 2 score ≥ 60)"; }
  else { dot.classList.add("bad"); document.getElementById("gateText").textContent = "Tier 3 locked until Tier 2 score ≥ 60"; }

  // Prompts
  document.getElementById("exam_prompts").textContent =
    "1) Document the disparity + affected segment (CHNA excerpt with page). 2) State the CRA qualifying criterion satisfied (and why benefit is targeted to LMI/qualifying population). 3) Define assessment area attribution (who benefited, where). 4) Provide invoices/contracts and beneficiary counts. 5) Define baseline metric + monitoring cadence.";
}

function setTier3FromOpportunity(opp){
  if(!opp) return;
  // Tier 3 currently models the NEMT scenario. If transportation is selected, prefill a conservative transport-share proxy.
  // (Keeps the existing Tier 3 ROI model intact.)
  if(opp.kind==="nmt" && state.transport.overall!=null){
    // Map CHNA-reported transportation barrier (% with transport problems) into a conservative "share due to transportation" proxy.
    const proxyPct = clamp(state.transport.overall*3.0, 5, 70); // heuristic: 2.7% -> ~8.1% (bounded)
    const el = document.getElementById("a_share");
    if(el) el.value = (proxyPct/100).toFixed(2); // accept decimal or percent; _normRate handles both
  }
}

function runTier3(){
  
  const activity = document.getElementById("inp_activity").value;
  const months = parseInt(document.getElementById("inp_months").value||"12",10);

  const annual = parseFloat(document.getElementById("inp_annual").value||"0");
  const baseRate = parseFloat(document.getElementById("inp_base").value||"0")/100;
  const share = parseFloat(document.getElementById("inp_share").value||"0")/100;
  const red = parseFloat(document.getElementById("inp_red").value||"0")/100;

  const covPct = parseFloat(document.getElementById("inp_cov").value||"25");
  const weightMode = document.getElementById("inp_weight_mode").value; // weighted | flat
  const senSharePct = clamp(parseFloat(document.getElementById("inp_sen_share").value||"25"), 0, 100);

  const benefitPer = parseFloat(document.getElementById("inp_benefit").value||"0");
  const startup = parseFloat(document.getElementById("inp_startup").value||"0");
  const fixed = parseFloat(document.getElementById("inp_fixed").value||"0");
  const varCost = parseFloat(document.getElementById("inp_var").value||"0");
  const unitsPer = parseFloat(document.getElementById("inp_units").value||"1");

  // Coverage and weighting logic:
  // Eligible touchpoints that receive support (targeted coverage).
  const eligibleTouchpoints = annual * (covPct/100);

  // Transport amplification factor from CHNA (65–74 vs overall) when available.
  let ampFactor = 1.0;
  if(state.transport.overall != null && state.transport.age6574 != null && state.transport.overall > 0){
    ampFactor = state.transport.age6574 / state.transport.overall; // e.g., 8.5/2.7 = 3.15x
  }
  if(weightMode === "flat") ampFactor = 1.0;

  // Effective barrier share adjusts upward when seniors are prioritized (higher transport barrier).
  const senShare = senSharePct/100;
  const effBarrierShare = clamp(share * ((1-senShare)*1.0 + (senShare*ampFactor)), 0, 1);

  // Disruptions among those offered support
  const baselineDisrupt = eligibleTouchpoints * baseRate;
  const barrierDisrupt = baselineDisrupt * effBarrierShare;
  const prevented = barrierDisrupt * red;

  // Units and benefit (annualized)
  const unitsAnnual = prevented * unitsPer;
  const grossAnnual = prevented * benefitPer;

  // cost over horizon: startup + fixed*months + variable*(annualUnits*months/12)*varCost
  const totalCostH = startup + fixed*months + (unitsAnnual*(months/12)*varCost);
  const annualCost = totalCostH*(12/months);
  const netAnnual = grossAnnual - annualCost;

  // Persist last model outputs for draft generator
  state.model = {
    activity, months, annual_touchpoints: annual,
    baseline_rate_pct: (baseRate*100),
    barrier_share_pct: (share*100),
    reduction_pct: (red*100),
    coverage_pct: Math.round(covPct),
    weight_mode: weightMode,
    seniors_share_pct: Math.round(senSharePct),
    amp_factor: (state.transport.overall && state.transport.age6574) ? (state.transport.age6574/state.transport.overall) : null,
    prevented_disruptions: prevented,
    units_annual: unitsAnnual,
    startup, fixed_monthly: fixed, variable_unit_cost: varCost, units_per_prevented: unitsPer,
    total_cost_horizon: totalCostH,
    annual_cost: annualCost,
    gross_annual_benefit: grossAnnual,
    net_annual: netAnnual
  };


  document.getElementById("kpi_cost").textContent = fmtMoney(annualCost);
  document.getElementById("kpi_gross").textContent = fmtMoney(grossAnnual);
  document.getElementById("kpi_net").textContent = fmtMoney(netAnnual);
  const covReadout = document.getElementById("cov_readout");
  if(covReadout) covReadout.textContent = `${Math.round(covPct)}%`;

  // Charts: ROI
  if(chartROI) chartROI.destroy();
  chartROI = new Chart(document.getElementById("chart_roi"),{
    type:"bar",
    data:{labels:["Annual benefit","Annual cost","Annual net"], datasets:[{label:"$", data:[grossAnnual, annualCost, netAnnual]}]},
    options:{plugins:{legend:{display:false}},
      scales:{x:{ticks:{color:"#2f4556"}, grid:{color:"rgba(11,31,51,.08)"}},
              y:{ticks:{color:"#2f4556"}, grid:{color:"rgba(11,31,51,.08)"}, beginAtZero:true}}}
  });

  // Monthly trend
  const labels = Array.from({length:months}, (_,i)=>`M${i+1}`);
  const monthlyBenefit = grossAnnual/12;
  const monthlyUnits = unitsAnnual/12;
  const monthlyCost = (startup/months) + fixed + (monthlyUnits*varCost);
  const monthlyNet = monthlyBenefit - monthlyCost;

  const netSeries = labels.map(()=>monthlyNet);
  let cum=0; const cumSeries = netSeries.map(v=>(cum+=v));
  if(chartTrend) chartTrend.destroy();
  chartTrend = new Chart(document.getElementById("chart_trend"),{
    type:"line",
    data:{labels, datasets:[
      {label:"Monthly net", data:netSeries, tension:.25},
      {label:"Cumulative net", data:cumSeries, tension:.25}
    ]},
    options:{plugins:{legend:{labels:{color:"#2f4556"}}},
      scales:{x:{ticks:{color:"#2f4556"}, grid:{color:"rgba(11,31,51,.08)"}},
              y:{ticks:{color:"#2f4556"}, grid:{color:"rgba(11,31,51,.08)"}}}}
  });

  // Break-even chart: vary coverage from 5..60
  const covs = [];
  const nets = [];
  const zeroLine = [];
  const minC = 5, maxC = 60;
  for(let c=minC; c<=maxC; c+=1){
    const eligible = annual * (c/100);
    const baseDis = eligible * baseRate;
    const barDis = baseDis * effBarrierShare;
    const prev = barDis * red;
    const unitsA = prev * unitsPer;
    const grossA = prev * benefitPer;
    const totalCost = startup + fixed*months + (unitsA*(months/12)*varCost);
    const annCost = totalCost*(12/months);
    covs.push(c);
    nets.push(grossA - annCost);
    zeroLine.push(0);
  }

  const ctxBE = document.getElementById("chart_breakeven");
  if(ctxBE){
    if(window.__beChart) window.__beChart.destroy();
    window.__beChart = new Chart(ctxBE, {
      type:"line",
      data:{
        labels: covs.map(x=>`${x}%`),
        datasets:[
          {label:"Annual net impact", data: nets, tension:.25},
          {label:"Break-even ($0)", data: zeroLine, borderDash:[6,6], tension:0}
        ]
      },
      options:{
        plugins:{legend:{labels:{color:"#2f4556"}}},
        scales:{
          x:{ticks:{color:"#2f4556", maxRotation:0, autoSkip:true}, grid:{color:"rgba(11,31,51,.08)"}},
          y:{ticks:{color:"#2f4556"}, grid:{color:"rgba(11,31,51,.08)"}}
        }
      }
    });
  }

  // Audit memo
  const topOpp = state.selectedOpp || state.opportunities[0] || null;
  const crit = topOpp ? topOpp.criterion : CRA_CRITERIA[activity]?.criterion || "—";
  const memo =
`TIER 3 — TOTAL PROGRAM COST & ROI (Audit-ready)

Selected activity: ${activity}
CRA criterion satisfied: ${crit}

A) Documented transportation disparity (CHNA)
- Transportation overall: ${state.transport.overall==null? "Not detected" : fmtPct(state.transport.overall)}
- Transportation age 65–74: ${state.transport.age6574==null? "Not detected" : fmtPct(state.transport.age6574)}
- Amplification factor: ${(state.transport.overall && state.transport.age6574) ? (state.transport.age6574/state.transport.overall).toFixed(1)+"×" : "—"}

B) Targeting design (this is the partnership lever)
- Targeted coverage of eligible patients: ${Math.round(covPct)}%
- Allocation mode: ${weightMode === "weighted" ? "Senior-weighted (prioritize 65–74)" : "Flat allocation"}
- Seniors share of eligible touchpoints: ${Math.round(senSharePct)}%
- Effective barrier share (after weighting): ${(effBarrierShare*100).toFixed(1)}%

C) Cost baseline (answers: “How much does it cost?”)
- Startup (one-time): ${fmtMoney(startup)}
- Fixed monthly cost: ${fmtMoney(fixed)}
- Variable unit cost: ${fmtMoney(varCost)}
- Units per prevented disruption: ${unitsPer.toFixed(2)}
- Estimated annual units: ${fmtInt(unitsAnnual)}
- Annualized program cost: ${fmtMoney(annualCost)}

D) Impact (annualized)
- Prevented disruptions: ${fmtInt(prevented)}
- Annual gross benefit: ${fmtMoney(grossAnnual)}
- Annual net impact: ${fmtMoney(netAnnual)}

E) Evidence packet
- CHNA excerpt(s) + subgroup differential + page refs
- Target population definition (LMI method) + geography attribution
- Contracts/invoices + service logs + beneficiary counts
- Monitoring cadence with baseline vs observed + corrective actions

Generated: ${new Date().toISOString()}`;
  document.getElementById("audit_out").textContent = memo;

}

// ------------------------------
// Export
// ------------------------------
function exportReport(){
  const report = {
    generated_at: new Date().toISOString(),
    docs: state.docs.map(d=>({name:d.name, pages:d.pages, type:d.type})),
    transport: state.transport,
    tier1_findings: state.findings,
    tier2_opportunities: state.opportunities,
    evidence: state.evidence.slice(-100)
  };
  const blob = new Blob([JSON.stringify(report,null,2)], {type:"application/json"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "chna_cra_dashboard_report.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ------------------------------
// Tabs
// ------------------------------
function setView(view){
  document.querySelectorAll(".view").forEach(v=>v.classList.remove("active"));
  const viewEl = document.getElementById("view_"+view);
  if(viewEl) viewEl.classList.add("active");
  document.querySelectorAll(".tabbtn").forEach(b=>b.classList.remove("active"));
  const tabEl = document.getElementById("tab_"+view);
  if(tabEl) tabEl.classList.add("active");

  // Training + Mayo modules are full-width; hide the main 2-col grid for both
  const grid = document.querySelector(".grid.grid-2");
  if(grid) grid.style.display = (view === "training" || view === "mayo") ? "none" : "";

  // Chart.js canvases can render at 0px when hidden; force a resize on tab switch.
  window.setTimeout(()=>{
    try{ if(chartMateriality) chartMateriality.resize(); }catch(e){}
    try{ if(chartROI) chartROI.resize(); }catch(e){}
    try{ if(chartTrend) chartTrend.resize(); }catch(e){}
    try{ if(window.__beChart) window.__beChart.resize(); }catch(e){}
  }, 60);
}
document.querySelectorAll(".tabbtn").forEach(btn=>{
  btn.addEventListener("click", ()=> setView(btn.dataset.view));
});

// ------------------------------
// Buttons
// ------------------------------
document.getElementById("btn_export").addEventListener("click", exportReport);

document.getElementById("btn_reset").addEventListener("click", ()=>{
  clearErr();
  state.docs=[]; state.evidence=[]; state.findings=[]; state.opportunities=[]; state.selectedOpp=null; state.chnaEval=[];
  state.transport={overall:null, age6574:null};
  document.getElementById("docs_count").textContent="0";
  document.getElementById("ev_count").textContent="0";
  document.getElementById("top_t2").textContent="—";
  document.getElementById("tbl_materiality").innerHTML="";
  document.getElementById("tbl_evidence").innerHTML="";
  document.getElementById("tbl_cra").innerHTML="";
  if(document.getElementById("tbl_chna_gaps")) document.getElementById("tbl_chna_gaps").innerHTML="";
  if(document.getElementById("chna_gap_recs")) document.getElementById("chna_gap_recs").textContent="—";
  document.getElementById("audit_out").textContent="";
  if(chartMateriality) chartMateriality.destroy();
  if(chartROI) chartROI.destroy();
  if(chartTrend) chartTrend.destroy();
  renderTransportSpotlight();
  showOk("Reset complete.");
});

document.getElementById("btn_demo").addEventListener("click", ()=>{
  clearErr();
  // Demo based on your exact framing: 2.7% overall, 8.5% age 65-74
  const demoText =
    "Why did you not get or delay getting the preventative care you thought you needed? Total: I had transportation problems 2.7%. " +
    "Age 65-74: I had transportation problems 8.5%. " +
    "Of patients surveyed, 7.5% reported food insecurity and 6% reported housing needs. " +
    "Unweighted count 61. Martin County ZIP 56031.";
  state.docs=[{name:"Demo_CHNA.pdf", type:"pdf", pages:1, textByPage:[demoText]}];
  state.evidence=[]; state.findings=[]; state.opportunities=[]; state.selectedOpp=null; state.chnaEval=[];
  state.transport={overall:null, age6574:null};

  scanDoc(state.docs[0]);
  state.chnaEval = state.docs.map(evalDocForElements);
  computeMateriality();
  buildOpportunities();
  state.selectedOpp = state.opportunities[0] || null;

  document.getElementById("docs_count").textContent = state.docs.length;
  document.getElementById("ev_count").textContent = state.evidence.length;

  renderTransportSpotlight();
  renderTier1();
  renderEvidence();
  renderTier2();
  showOk("Demo loaded (transportation differential).");
});

document.getElementById("btn_process").addEventListener("click", async ()=>{
  clearErr();
  showOk("Processing… (parsing documents and updating Tier 1–3 outputs)");
  try{
    const files = Array.from(document.getElementById("file_input").files || []);
    if(!files.length){
      showErr("No files selected.");
      return;
    }
    state.docs=[]; state.evidence=[]; state.findings=[]; state.opportunities=[]; state.selectedOpp=null; state.chnaEval=[];
    state.transport={overall:null, age6574:null};

    for(const f of files){
      const ext = (f.name.split(".").pop()||"").toLowerCase();
      let parsed=null;
      try{
        if(ext==="pdf") parsed = await extractPdfText(f);
        else if(ext==="txt") parsed = await extractTxt(f);
        else {
          // Skip unsupported files without failing the run
          continue;
        }
        state.docs.push({name:f.name, type:ext, pages:parsed.pages, textByPage:parsed.textByPage});
      }catch(e){
        showErr(`Error parsing ${escapeHtml(f.name)}. If the PDF is scanned, upload a text-based PDF or a .txt export.`);
        console.error(e);
      }
    }

    if(!state.docs.length){
      showErr("No supported files were parsed. Please upload text-based PDFs or .txt files.");
      return;
    }

    // Scan
    for(const d of state.docs){ scanDoc(d); }
    state.chnaEval = state.docs.map(evalDocForElements);
    computeMateriality();
    buildOpportunities();
    state.selectedOpp = state.opportunities[0] || null;

    document.getElementById("docs_count").textContent = state.docs.length;
    document.getElementById("ev_count").textContent = state.evidence.length;

    renderTransportSpotlight();
    renderTier1();
    renderEvidence();
    renderTier2();

    // Ensure charts render even if user is not currently on the chart tab
    window.setTimeout(()=>{
      try{ if(chartMateriality) chartMateriality.resize(); }catch(e){}
      try{ if(chartROI) chartROI.resize(); }catch(e){}
      try{ if(chartTrend) chartTrend.resize(); }catch(e){}
    }, 80);

    showOk(`Processed ${state.docs.length} document(s). Evidence hits: ${state.evidence.length}.`);
    if(state.evidence.length===0){
      showErr("Documents were parsed, but no recognizable CHNA signals were detected. This often happens with scanned PDFs (images). Try exporting to text or uploading a .txt version.");
    }
  }catch(e){
    console.error(e);
    showErr("Processing failed: " + (e && e.message ? e.message : String(e)));
  }
});

document.getElementById("btn_use_top").addEventListener("click", ()=>{
  if(!state.opportunities.length){
    showErr("No Tier 2 opportunities available yet.");
    return;
  }
  state.selectedOpp = state.opportunities[0];
  setTier3FromOpportunity(state.selectedOpp);
  setView("t3");
  showOk("Tier 3 prefilled using top Tier 2 opportunity.");
});

const _btn_autofill = document.getElementById("btn_autofill");
if(_btn_autofill){
  _btn_autofill.addEventListener("click", ()=>{
    if(!state.selectedOpp) state.selectedOpp = state.opportunities[0] || null;
    if(state.selectedOpp) setTier3FromOpportunity(state.selectedOpp);
    showOk("Tier 3 auto-fill applied from Tier 2.");
  });
}

const _btn_run = document.getElementById("btn_run");
if(_btn_run){ _btn_run.addEventListener("click", runTier3); }
// Live UI: keep coverage readout updated
const covEl = document.getElementById("inp_cov");
const covRead = document.getElementById("cov_readout");
if(covEl && covRead){
  covRead.textContent = `${covEl.value}%`;
  covEl.addEventListener("input", ()=>{ covRead.textContent = `${covEl.value}%`; });
}


// Initial render placeholders
renderTransportSpotlight();
document.getElementById("tbl_materiality").innerHTML = "<tr><th>Disparity</th><th>Segment</th><th>Magnitude</th><th>Δ Concentration</th><th>Prominence</th><th>Score</th><th>Recommendation</th><th>Evidence</th></tr><tr><td colspan='8'>Upload documents and click Process Files.</td></tr>";
document.getElementById("tbl_evidence").innerHTML = "<tr><th>Disparity</th><th>Snippet</th><th>Doc</th><th>Page</th></tr><tr><td colspan='4'>—</td></tr>";
document.getElementById("tbl_cra").innerHTML = "<tr><th>Opportunity</th><th>CRA test mapping</th><th>Criterion satisfied</th><th>Strength</th><th>Score</th><th>Scope guidance</th><th>Application packet checklist</th></tr><tr><td colspan='7'>—</td></tr>";
if(document.getElementById("tbl_chna_gaps")) document.getElementById("tbl_chna_gaps").innerHTML = "<tr><th>Document</th><th>CHNA score</th><th>IS score</th><th>Written comments</th><th>Public availability</th><th>Top gaps (auto)</th><th>Evidence</th></tr><tr><td colspan=\"7\">—</td></tr>";
if(document.getElementById("chna_gap_recs")) document.getElementById("chna_gap_recs").textContent = "Upload CHNA/IS documents and click Process Files.";

// initialize draft UI
wireDraftUI();


// ------------------------------
// Draft Generator (Application artifacts)
// ------------------------------
function pickOpportunity(kind){
  if(!state.opportunities || state.opportunities.length===0) return null;
  if(kind==="auto") return state.opportunities[0];
  return state.opportunities.find(o=>o.kind===kind) || state.opportunities[0];
}

function topEvidenceLines(maxLines=4){
  const lines = [];
  // Prefer transportation: show overall + 65–74 if available
  if(state.transport.overall!=null){
    lines.push(`- Transportation barrier overall: ${fmtPct(state.transport.overall)} (source: ${findEvidenceRef("Transportation barrier", "Overall") || "see evidence table"})`);
  }
  if(state.transport.age6574!=null){
    lines.push(`- Transportation barrier age 65–74: ${fmtPct(state.transport.age6574)} (source: ${findEvidenceRef("Transportation barrier", "Age 65") || "see evidence table"})`);
  }
  const others = state.findings.filter(f=>f.key!=="transport").slice(0, maxLines);
  for(const f of others){
    lines.push(`- ${f.disparity} (${f.segment}): ${fmtPct(f.magnitude)} (evidence: ${f.evidenceRef||"—"})`);
  }
  return lines.join("\n");
}

function findEvidenceRef(disparityLabel, segmentHint){
  const f = state.findings.find(x => x.disparity === disparityLabel && (!segmentHint || x.segment.includes(segmentHint)));
  return f ? f.evidenceRef : null;
}

function appPacketChecklist(kind){
  const common = [
    "CHNA excerpt(s) with page references (documented need + affected segment)",
    "Target population definition (LMI method and/or qualifying segment definition)",
    "Geographic attribution method (AA mapping via ZIP/tract/county; proportional benefit if broader)",
    "Contracts/MOUs/service agreements and invoices (clean audit trail)",
    "Service logs and beneficiary counts (units delivered; counts served; LMI estimate)",
    "Monitoring cadence (baseline vs observed; variance notes; corrective actions)"
  ];
  const nmt = [
    "Ride logs (date/time pickup/dropoff; appointment type; beneficiary ZIP)",
    "Broker/vendor KPIs (on-time rate, completed rides, cancellations, no-shows)",
    "Eligibility gating rationale (senior prioritization supported by CHNA differential)"
  ];
  const food = [
    "Distribution logs (units delivered; eligibility; geography)",
    "Partner controls (stock, delivery cadence, audit spot-checks)"
  ];
  const care = [
    "Workflow documentation (referral pathways; intake criteria)",
    "Referral counts and closed-loop outcomes"
  ];
  let extra = [];
  if(kind==="nmt") extra = nmt;
  if(kind==="food") extra = food;
  if(kind==="care") extra = care;
  return common.concat(extra).map(x=>`- ${x}`).join("\n");
}

function renderCrosswalkTable(opportunity){
  const rows = state.opportunities.map(o => {
    return `| ${o.opp} | ${o.tests} | ${o.criterion} | ${o.score} (${o.strength}) | ${o.scope} |`;
  });
  return [
    "| Opportunity | CRA test mapping | Criterion satisfied | Readiness | Scope guidance |",
    "|---|---|---|---|---|",
    ...rows
  ].join("\n");
}

function draftHeader(tone, projectName){
  const title = projectName ? projectName : "CRA‑Aligned Health Access Initiative";
  const toneLine = tone==="bank" ? "Bank CRA File Draft" : (tone==="hospital" ? "Hospital Internal Approval Draft" : "Joint Bank–Hospital Draft");
  return `${title}\n${toneLine}\nGenerated: ${new Date().toISOString()}\n`;
}

function generateDraft(draftType, oppKind, tone){
  const opp = pickOpportunity(oppKind);
  const projectName = (document.getElementById("draft_project_name")?.value || "").trim();
  const partner = (document.getElementById("draft_partner")?.value || "").trim();
  const scopeNote = (document.getElementById("draft_scope_note")?.value || "").trim();
  const structure = (document.getElementById("draft_structure")?.value || "").trim();

  const header = draftHeader(tone, projectName);
  const oppLine = opp ? `${opp.opp}\nCRA criterion satisfied: ${opp.criterion}\nCRA test mapping: ${opp.tests}\nReadiness: ${opp.score} (${opp.strength})\n` :
    "No Tier 2 opportunities available yet. Process documents first.\n";

  const evidence = topEvidenceLines(4);

  // Tier 3 model inclusion when available
  let modelBlock = "Tier 3 (cost & ROI): Not yet run. Run Tier 3 to populate cost baseline and break‑even assumptions.\n";
  if(state.model){
    modelBlock =
`Tier 3 (cost & ROI) — most recent scenario:
- Activity: ${state.model.activity}
- Coverage: ${state.model.coverage_pct}% (${state.model.weight_mode === "weighted" ? "senior‑weighted" : "flat"}; seniors share ${state.model.seniors_share_pct}%)
- Annualized program cost: ${fmtMoney(state.model.annual_cost)}
- Annual gross benefit: ${fmtMoney(state.model.gross_annual_benefit)}
- Annual net impact: ${fmtMoney(state.model.net_annual)}
- Assumptions: baseline disruption ${state.model.baseline_rate_pct.toFixed(1)}%, barrier share ${state.model.barrier_share_pct.toFixed(1)}%, reduction ${state.model.reduction_pct.toFixed(1)}%.\n`;
  }

  const orgLines = [
    partner ? `Implementing partner: ${partner}` : null,
    structure ? `Funding structure: ${structure}` : null,
    scopeNote ? `AA/scope note: ${scopeNote}` : null
  ].filter(Boolean).join("\n");

  if(draftType==="cra_memo"){
    return `${header}
1) Selected opportunity
${oppLine}
${orgLines ? orgLines + "\n" : ""}

2) Performance context and documented need (CHNA evidence)
${evidence}

3) Why this is responsive (what changes)
- The activity is targeted to the population segment(s) with the largest documented access disruption (e.g., seniors where transportation barrier is amplified).
- The implementation design includes traceable eligibility, service logs, and geography attribution to support exam defensibility.

4) Eligibility criterion satisfied (explicit)
${opp ? opp.criterion : "—"}

5) Scope and attribution
- Primary: attribute benefit within the bank’s assessment area by documenting beneficiary location (ZIP/tract/county) and delivery footprint.
- Secondary: if broader, document proportional benefit allocation and retain mapping evidence.

6) Program cost baseline and impact (decision support)
${modelBlock}

7) Evidence & monitoring packet (minimum)
${appPacketChecklist(opp ? opp.kind : "nmt")}
`;
  }

  if(draftType==="exam_narrative"){
    const amp = (state.transport.overall && state.transport.age6574) ? (state.transport.age6574/state.transport.overall) : null;
    const ampLine = amp ? `Transportation barriers were amplified among older adults (~${amp.toFixed(1)}× vs overall), supporting a targeted access response.` : `Transportation barriers were documented in the CHNA and used to target the activity.`;
    return `${header}
Examiner‑facing narrative (Performance Evaluation style)

The institution supported a community services initiative aligned to documented local needs. ${ampLine}
The activity was structured to meet the CRA qualifying criterion as a community development service targeted to low‑ or moderate‑income individuals (criterion and support documentation retained). The institution maintained an audit trail including service logs, invoices, and beneficiary counts, and tracked outcomes against a defined baseline.

Evidence basis (CHNA excerpts):
${evidence}

CRA criterion satisfied:
${opp ? opp.criterion : "—"}

${state.model ? "Quantified program cost and impact (annualized):\n- Cost: "+fmtMoney(state.model.annual_cost)+"\n- Net impact: "+fmtMoney(state.model.net_annual)+"\n" : ""}`;
  }

  if(draftType==="crosswalk"){
    return `${header}
CRA Eligibility Crosswalk (working)

${renderCrosswalkTable(opp)}
`;
  }

  if(draftType==="term_sheet"){
    return `${header}
Joint Partnership Term Sheet (working draft)

Project: ${projectName || (opp ? opp.opp : "—")}
Purpose: Address documented access disparities through a targeted intervention aligned with CRA community development criteria.

Parties:
- Hospital: _______________________
- Bank: ___________________________
${partner ? "- Implementing partner: "+partner+"\n" : ""}

Need statement (CHNA):
${evidence}

CRA criterion satisfied:
${opp ? opp.criterion : "—"}

Geographic attribution:
- Assessment area targeting: document beneficiary location and service footprint.
${scopeNote ? "- Notes: "+scopeNote+"\n" : ""}

Funding structure:
${structure || "TBD (grant / investment / service agreement — choose the structure that best aligns with bank CRA strategy and hospital operations)."}

Budget baseline (annualized):
${state.model ? "- Program cost: "+fmtMoney(state.model.annual_cost)+"\n- Expected net impact: "+fmtMoney(state.model.net_annual)+"\n" : "- Run Tier 3 to populate cost baseline and scenario.\n"}

Evidence & reporting:
${appPacketChecklist(opp ? opp.kind : "nmt")}

Sign‑off workflow:
- Hospital approval: ____________________
- Bank CRA approval: ___________________
`;
  }

  if(draftType==="chna_brief"){
    return `${header}
CHNA Implementation Alignment Brief

CHNA‑documented need:
${evidence}

Selected intervention:
${oppLine}

Implementation summary:
- Target segment(s): older adults prioritized when transportation barriers are amplified; additional eligibility defined by LMI method and service area.
- Delivery model: partner/brokered NEMT with documented ride logs and monitoring.

Budget and evaluation:
${modelBlock}

KPIs:
- Completed rides
- Prevented disruptions (missed appointments)
- Beneficiary counts and geography attribution
- Monthly monitoring with corrective action triggers
`;
  }

  if(draftType==="monitor_plan"){
    return `${header}
Monitoring & Evidence Plan (Exam‑ready)

Selected opportunity:
${oppLine}

Data capture (minimum):
${appPacketChecklist(opp ? opp.kind : "nmt")}

Monitoring cadence:
- Weekly: operational exceptions (cancellations, no‑shows, delayed pickups)
- Monthly: units delivered; beneficiary counts; geography attribution spot check; budget variance
- Quarterly: baseline vs observed disruption rate; program adjustments and corrective actions

Outputs:
- Audit trail pack (contracts/invoices/service logs)
- Quarterly narrative of responsiveness and observed performance
`;
  }


  if(draftType==="pnl"){
    const m = state.model?.outputs;
    if(!m) return `${header}\nP&L Draft unavailable: Run Tier 3 ROI first.\n`;
    const baseNet = m.net_benefit;
    const coding = state.model?.coding?.uplift || 0;
    const totalNet = state.model?.totalNet ?? (baseNet + coding);

    return `${header}
Borrower P&L Statement (Hospital) — Annualized (Draft)

Revenue & Contribution:
- Gross revenue recaptured: ${fmtMoney(m.gross_rev)}
- Less: Marginal clinical cost: ${fmtMoney(m.marginal_cost)}
= Contribution margin from recovered visits: ${fmtMoney(m.gross_rev - m.marginal_cost)}

Program Costs:
- Transportation direct cost: ${fmtMoney(m.transport_cost)}
- Program overhead cost: ${fmtMoney(m.overhead_cost)}
= Total program cost: ${fmtMoney(m.total_program_cost)}

Net Operating Result (Base, Excel parity):
- Net annual benefit: ${fmtMoney(baseNet)}

Optional Coding Layer (if enabled):
- Coding uplift: ${fmtMoney(coding)}
- Net incl. coding uplift: ${fmtMoney(totalNet)}

Notes:
- Base ROI follows Excel-parity incremental margin model.
- Coding uplift is optional and should be supported by documentation workflows and coding governance.
`;
  }

  if(draftType==="proforma_3yr"){
    const m = state.model?.outputs;
    if(!m) return `${header}\n3-Year Pro Forma unavailable: Run Tier 3 ROI first.\n`;

    // simple conservative pro forma: allow growth & inflation assumptions (defaults)
    const growth = parseFloat((document.getElementById("draft_growth")?.value || "5"))/100;
    const infl = parseFloat((document.getElementById("draft_infl")?.value || "3"))/100;

    const y1_rev = m.gross_rev;
    const y1_marg = m.marginal_cost;
    const y1_cost = m.total_program_cost;
    const y1_net = m.net_benefit;

    const rows = [];
    for(let yr=1; yr<=3; yr++){
      const factor = Math.pow(1+growth, yr-1);
      const costFactor = Math.pow(1+infl, yr-1);
      const rev = y1_rev * factor;
      const marg = y1_marg * factor;
      const prog = y1_cost * costFactor;
      const net = rev - marg - prog;
      rows.push({yr, rev, marg, prog, net});
    }

    const table = rows.map(r=>`Year ${r.yr}: Revenue ${fmtMoney(r.rev)} | Marginal cost ${fmtMoney(r.marg)} | Program cost ${fmtMoney(r.prog)} | Net ${fmtMoney(r.net)}`).join("\n");

    return `${header}
Project Pro Forma Budget (3-Year) — Draft

Assumptions:
- Volume/revenue growth on recovered visits: ${(growth*100).toFixed(1)}% / year
- Program cost inflation: ${(infl*100).toFixed(1)}% / year
- Base Year 1 values derived from Tier 3 ROI (Excel parity)

3-Year Summary:
${table}

Interpretation:
- Year 1 is the conservative base case (spreadsheet parity).
- Growth reflects program maturation and improved engagement.
- Inflation reflects vendor and admin cost escalation.
`;
  }

  
  if(draftType==="lender_pnl_3yr" || draftType==="lender_proforma_3yr"){
    // Build a lender-facing, line-item 3-year package.
    // Uses most recent Tier 3 ROI run when available; otherwise derives from current Tier 3 input fields.
    let scen = null;
    try{
      if(state.model && state.model.outputs && state.model.inputs){
        scen = {inp: state.model.inputs, out: state.model.outputs, cu: state.model.coding || {uplift:0, detail:""}, totalNet: (state.model.totalNet ?? (state.model.outputs.net_benefit + ((state.model.coding||{}).uplift||0)))};
      }else{
        const inp = roi_inputs();
        const out = roi_calc(inp);
        const cu = coding_uplift(out.prevented, inp.visits);
        scen = {inp, out, cu, totalNet: (out.net_benefit + cu.uplift)};
      }
    }catch(e){
      scen = null;
    }

    if(!scen){
      return `${header}\nLender-facing financial artifacts unavailable: run Tier 3 ROI (or ensure Tier 3 inputs are present).\n`;
    }

    const growth = parseFloat((document.getElementById("draft_growth")?.value || "5"))/100;
    const infl = parseFloat((document.getElementById("draft_infl")?.value || "3"))/100;

    // Year 1 base (annualized) from ROI parity model
    const y1 = {
      recovered_visits: scen.out.prevented,
      patient_service_revenue: scen.out.gross_rev,
      quality_uplift: scen.cu?.uplift ? scen.cu.uplift : 0,
      total_revenue: scen.out.gross_rev + (scen.cu?.uplift ? scen.cu.uplift : 0),
      marginal_clinical_cost: scen.out.marginal_cost,
      nmt_vendor_cost: scen.out.transport_cost,
      admin_overhead_total: scen.out.overhead_cost,
      total_program_cost: scen.out.total_program_cost,
      net_contribution: (scen.out.gross_rev - scen.out.marginal_cost - scen.out.total_program_cost) + (scen.cu?.uplift ? scen.cu.uplift : 0)
    };

    // Overhead allocation (for line-item transparency; totals reconcile to ROI overhead)
    const ohAlloc = [
      {k:"Program management & operations", p:0.35},
      {k:"Patient outreach, scheduling & confirmations", p:0.20},
      {k:"Data, reporting & audit trail (CRA/CHNA)", p:0.18},
      {k:"Compliance & legal / contracting", p:0.12},
      {k:"Evaluation & continuous improvement", p:0.10},
      {k:"IT/tools (workflow enablement)", p:0.05}
    ];

    function projectYear(base, yr){
      const volF = Math.pow(1+growth, yr-1);
      const costF = Math.pow(1+infl, yr-1);

      const recovered = base.recovered_visits * volF;
      const rev = base.patient_service_revenue * volF;
      const qual = base.quality_uplift * volF; // conservative: tie to volume
      const totRev = rev + qual;

      const marg = base.marginal_clinical_cost * volF;
      const nmt = base.nmt_vendor_cost * costF; // vendor cost inflation
      const oh = base.admin_overhead_total * costF;
      const prog = nmt + oh;

      const net = (rev - marg - prog) + qual;

      return {recovered, rev, qual, totRev, marg, nmt, oh, prog, net};
    }

    const y2 = projectYear(y1, 2);
    const y3 = projectYear(y1, 3);

    const table3 =
`3-Year Summary (annual, $)
| Line item | Year 1 | Year 2 | Year 3 |
|---|---:|---:|---:|
| Recovered visits enabled | ${Math.round(y1.recovered_visits).toLocaleString()} | ${Math.round(y2.recovered).toLocaleString()} | ${Math.round(y3.recovered).toLocaleString()} |
| Patient service revenue (net) | ${fmtMoney(y1.patient_service_revenue)} | ${fmtMoney(y2.rev)} | ${fmtMoney(y3.rev)} |
| Quality / coding uplift (optional) | ${fmtMoney(y1.quality_uplift)} | ${fmtMoney(y2.qual)} | ${fmtMoney(y3.qual)} |
| **Total revenue** | **${fmtMoney(y1.total_revenue)}** | **${fmtMoney(y2.totRev)}** | **${fmtMoney(y3.totRev)}** |
| Marginal clinical cost | ${fmtMoney(y1.marginal_clinical_cost)} | ${fmtMoney(y2.marg)} | ${fmtMoney(y3.marg)} |
| NEMT vendor expense (variable) | ${fmtMoney(y1.nmt_vendor_cost)} | ${fmtMoney(y2.nmt)} | ${fmtMoney(y3.nmt)} |
| Admin/overhead (allocated) | ${fmtMoney(y1.admin_overhead_total)} | ${fmtMoney(y2.oh)} | ${fmtMoney(y3.oh)} |
| **Total program cost** | **${fmtMoney(y1.total_program_cost)}** | **${fmtMoney(y2.prog)}** | **${fmtMoney(y3.prog)}** |
| **Net contribution (EBITDA-like)** | **${fmtMoney(y1.net_contribution)}** | **${fmtMoney(y2.net)}** | **${fmtMoney(y3.net)}** |
`;

    const overheadDetail = ohAlloc.map(a=>{
      const v1 = y1.admin_overhead_total * a.p;
      const v2 = y2.oh * a.p;
      const v3 = y3.oh * a.p;
      return `| ${a.k} | ${fmtMoney(v1)} | ${fmtMoney(v2)} | ${fmtMoney(v3)} |`;
    }).join("\n");

    const overheadTable =
`Overhead detail (reconciles to ROI overhead; for lender transparency)
| Overhead line item | Year 1 | Year 2 | Year 3 |
|---|---:|---:|---:|
${overheadDetail}
| **Total allocated overhead** | **${fmtMoney(y1.admin_overhead_total)}** | **${fmtMoney(y2.oh)}** | **${fmtMoney(y3.oh)}** |
`;

    const assumptions =
`Core assumptions (from Tier 3 inputs)
- Annual targeted visits: ${Math.round(scen.inp.visits).toLocaleString()}
- No-show rate: ${(scen.inp.noshow*100).toFixed(1)}%
- Share due to transportation: ${(scen.inp.share*100).toFixed(1)}%
- Mitigation (prevented share): ${(scen.inp.mitig*100).toFixed(1)}%
- Net revenue per recovered visit: $${(scen.inp.netrev||0).toFixed(0)}
- Marginal clinical cost per recovered visit: $${(scen.inp.margc||0).toFixed(0)}
- Trip cost: $${(scen.inp.trip||0).toFixed(0)}  | Overhead rate: ${(scen.inp.over*100).toFixed(1)}%
- Growth on recovered volume: ${(growth*100).toFixed(1)}%/yr  | Cost inflation: ${(infl*100).toFixed(1)}%/yr
`;

    if(draftType==="lender_pnl_3yr"){
      return `${header}
LENDER-FACING 3-YEAR P&L (Incremental Program Economics — Line-Item)

Purpose
This statement isolates incremental operating impact of a CRA-aligned access program on the hospital (borrower),
using the dashboard ROI scenario as the Year 1 base and projecting Years 2–3 using the selected growth/inflation assumptions.

${assumptions}

${table3}

${overheadTable}

Lender notes (how to underwrite this)
- Revenue line represents net patient service revenue recovered from prevented transportation-related no-shows.
- Marginal clinical cost reflects variable clinical expense tied to recovered visits (not fully loaded fixed cost).
- Program cost is variable with volume and vendor pricing; overhead is transparently allocated for governance, audit, and reporting.
- Optional “quality/coding uplift” should be included only if documentation and coding governance controls are implemented (e.g., workflow prompts, QA sampling).

Risk controls (what reduces variability)
- Eligibility + ride-log documentation to minimize leakage and support CRA/CHNA defensibility.
- Vendor SLA (on-time pickup, completion rate) + monthly variance review.
- Audit-ready evidence pack (contracts, invoices, beneficiary counts, AA attribution).

Generated: ${new Date().toISOString()}
`;
    }

    // lender_proforma_3yr
    const sourcesUses =
`Sources & Uses (illustrative; editable)
Sources:
- Bank CRA contribution (annual): $${(scen.inp.bank||0).toLocaleString()}
- Hospital contribution (annual): ${fmtMoney(Math.max(0, y1.total_program_cost - (scen.inp.bank||0)))}
Uses:
- NEMT vendor expense: ${fmtMoney(y1.nmt_vendor_cost)}
- Program overhead (allocated): ${fmtMoney(y1.admin_overhead_total)}
`;

    return `${header}
LENDER-FACING 3-YEAR PRO FORMA (Budget + Performance — Line-Item)

Purpose
This pro forma is structured as a lender-ready attachment: (1) clear assumptions, (2) line-item cost structure,
(3) projected operating contribution, and (4) documentation / controls that reduce performance risk.

${assumptions}

${sourcesUses}

${table3}

${overheadTable}

Performance monitoring (what the lender can request quarterly)
- Volumes: rides delivered; recovered visits; cancellation/no-show rates.
- Financial: program cost per recovered visit; net contribution; variance to pro forma.
- Compliance: evidence completeness (contracts/invoices/ride logs/beneficiary counts); AA and LMI attribution checks.
- Outcomes: appointment adherence trend; patient experience measures (optional).

Generated: ${new Date().toISOString()}
`;
  }
// fallback
  return `${header}\nNo draft type selected.\n`;
}

function wireDraftUI(){
  const genBtn = document.getElementById("btn_generate_draft");
  if(!genBtn) return; // view not present
  genBtn.addEventListener("click", ()=>{
    const type = document.getElementById("draft_type").value;
    const kind = document.getElementById("draft_activity").value;
    const tone = document.getElementById("draft_tone").value;
    const txt = generateDraft(type, kind, tone);
    document.getElementById("draft_preview").textContent = txt;
  });

  document.getElementById("btn_copy_draft").addEventListener("click", async ()=>{
    const txt = document.getElementById("draft_preview").textContent || "";
    try{
      await navigator.clipboard.writeText(txt);
      showOk("Draft copied to clipboard.");
    }catch(e){
      showOk("Copy failed in this browser. You can manually select the text and copy.");
    }
  });

  document.getElementById("btn_download_draft").addEventListener("click", ()=>{
    const txt = document.getElementById("draft_preview").textContent || "";
    const blob = new Blob([txt], {type:"text/plain"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const type = document.getElementById("draft_type").value;
    a.download = `cra_application_${type}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });
}


function _num(id){
  const el = document.getElementById(id);
  if(!el) return 0;
  let v = parseFloat(el.value);
  if(isNaN(v)) return 0;
  return (v > 1) ? v/100 : v; // normalize percent-style
}



function _normRate(x){
  // Accept decimals (0.2) or percents (20)
  if(isNaN(x)) return 0;
  return (x > 1) ? (x/100) : x;
}

function roi_inputs(){
  const visits = parseFloat(document.getElementById("a_visits").value) || 0;
  return {
    visits,
    noshow: _normRate(parseFloat(document.getElementById("a_noshow").value)),
    share: _normRate(parseFloat(document.getElementById("a_share").value)),
    netrev: parseFloat(document.getElementById("a_netrev").value) || 0,
    margc: parseFloat(document.getElementById("a_margc").value) || 0,
    mitig: _normRate(parseFloat(document.getElementById("b_mitig").value)),
    trip: parseFloat(document.getElementById("b_trip").value) || 0,
    over: _normRate(parseFloat(document.getElementById("b_over").value)),
    lmi: _normRate(parseFloat(document.getElementById("c_lmi").value)),
    aa: _normRate(parseFloat(document.getElementById("c_aa").value)),
    bank: parseFloat(document.getElementById("c_bank").value) || 0
  };
}

function roi_calc(inp){
  const transport_no_shows = inp.visits * inp.noshow * inp.share;
  const prevented = transport_no_shows * inp.mitig;
  const gross_rev = prevented * inp.netrev;
  const marginal_cost = prevented * inp.margc;
  const transport_cost = prevented * inp.trip;
  const overhead_cost = transport_cost * inp.over;
  const total_program_cost = transport_cost + overhead_cost;
  const net_benefit = gross_rev - marginal_cost - total_program_cost;
  const be_trip_max = inp.netrev - inp.margc;

  const trips = prevented;
  const lmi_trips = trips * inp.lmi;
  const aa_trips = trips * inp.aa;
  const bank_per_lmi = (lmi_trips===0) ? 0 : (inp.bank/lmi_trips);
  const bank_share_cost = (total_program_cost===0) ? 0 : (inp.bank/total_program_cost);

  const narrative = `Estimated ${Math.round(lmi_trips).toLocaleString()} LMI trips and ${Math.round(trips).toLocaleString()} essential visits enabled annually within the Assessment Area.`;
  return {transport_no_shows, prevented, gross_rev, marginal_cost, transport_cost, overhead_cost, total_program_cost, net_benefit, be_trip_max,
          trips, lmi_trips, aa_trips, bank_per_lmi, bank_share_cost, narrative};
}

function coding_uplift(preventedVisits, allVisits){
  const enabled = document.getElementById("toggle_coding").checked;
  if(!enabled) return {uplift:0, detail:"Coding layer not enabled."};

  const zRate = _normRate(parseFloat(document.getElementById("z_rate").value));
  const zUplift = parseFloat(document.getElementById("z_uplift").value) || 0;
  const cptRate = _normRate(parseFloat(document.getElementById("cpt_rate").value));
  const cptUplift = parseFloat(document.getElementById("cpt_uplift").value) || 0;
  const base = document.getElementById("coding_base").value; // prevented | all
  const n = (base === "all") ? allVisits : preventedVisits;

  const zAdd = n * zRate * zUplift;
  const cptAdd = n * cptRate * cptUplift;
  const uplift = zAdd + cptAdd;

  const notes = (document.getElementById("coding_notes").value || "").trim();
  const detail = `Coding uplift applied to ${base === "all" ? "all targeted visits" : "recovered visits"}:
- Z-code capture: ${(zRate*100).toFixed(1)}% × $${zUplift.toFixed(0)} = $${zAdd.toFixed(0)}
- CPT capture: ${(cptRate*100).toFixed(1)}% × $${cptUplift.toFixed(0)} = $${cptAdd.toFixed(0)}
${notes ? "- Notes: " + notes : ""}`.trim();

  return {uplift, detail};
}

function ccm_tcm_calc(){
  const enabled = document.getElementById("toggle_ccm")?.checked;
  if(!enabled) return {ccm_net:0, tcm_net:0, detail:"CCM/TCM layer not enabled.", enabled:false};

  // CCM
  const ccm_patients = parseFloat(document.getElementById("ccm_patients")?.value)||0;
  const ccm_enroll = _normRate(parseFloat(document.getElementById("ccm_enroll")?.value)||0);
  const ccm_months = parseFloat(document.getElementById("ccm_months")?.value)||0;
  const ccm_allowed = parseFloat(document.getElementById("ccm_allowed")?.value)||0;
  const ccm_success = _normRate(parseFloat(document.getElementById("ccm_success")?.value)||0);
  const ccm_staff_rate = parseFloat(document.getElementById("ccm_staff_rate")?.value)||0;
  const ccm_minutes = parseFloat(document.getElementById("ccm_minutes")?.value)||0;

  const ccm_enrolled = ccm_patients * ccm_enroll;
  const ccm_billed_months = ccm_enrolled * ccm_months * ccm_success;
  const ccm_gross = ccm_billed_months * ccm_allowed;
  const ccm_labor = ccm_billed_months * ccm_minutes * ccm_staff_rate;
  const ccm_net = ccm_gross - ccm_labor;

  // TCM
  const tcm_discharges = parseFloat(document.getElementById("tcm_discharges")?.value)||0;
  const tcm_reach = _normRate(parseFloat(document.getElementById("tcm_reach")?.value)||0);
  const tcm_high_share = _normRate(parseFloat(document.getElementById("tcm_high_share")?.value)||0);
  const tcm_allow_mod = parseFloat(document.getElementById("tcm_allow_mod")?.value)||0;
  const tcm_allow_high = parseFloat(document.getElementById("tcm_allow_high")?.value)||0;
  const tcm_success = _normRate(parseFloat(document.getElementById("tcm_success")?.value)||0);
  const tcm_minutes = parseFloat(document.getElementById("tcm_minutes")?.value)||0;
  const tcm_staff_rate = parseFloat(document.getElementById("tcm_staff_rate")?.value)||0;

  const tcm_episodes = tcm_discharges * tcm_reach * tcm_success;
  const tcm_avg_allowed = tcm_high_share * tcm_allow_high + (1-tcm_high_share) * tcm_allow_mod;
  const tcm_gross = tcm_episodes * tcm_avg_allowed;
  const tcm_labor = tcm_episodes * tcm_minutes * tcm_staff_rate;
  const tcm_net = tcm_gross - tcm_labor;

  const detail = `CCM:\n- Enrolled: ${Math.round(ccm_enrolled).toLocaleString()} patients\n- Billed patient-months: ${Math.round(ccm_billed_months).toLocaleString()}\n- Gross revenue: ${fmtMoney(ccm_gross)} | Labor: ${fmtMoney(ccm_labor)}\n- Net CCM contribution: ${fmtMoney(ccm_net)}\n\nTCM:\n- Billable episodes: ${Math.round(tcm_episodes).toLocaleString()}\n- Avg allowed: $${tcm_avg_allowed.toFixed(0)}\n- Gross revenue: ${fmtMoney(tcm_gross)} | Labor: ${fmtMoney(tcm_labor)}\n- Net TCM contribution: ${fmtMoney(tcm_net)}\n\n⚠️ CCM/TCM time must be real, threshold-meeting, and non-duplicative. Consult compliance before operationalizing.`;
  return {ccm_net, tcm_net, ccm_gross, tcm_gross, ccm_labor, tcm_labor, ccm_enrolled, ccm_billed_months, tcm_episodes, detail, enabled:true};
}

function vbc_calc(){
  const enabled = document.getElementById("toggle_vbc")?.checked;
  if(!enabled) return {earn:0, detail:"VBC Quality layer not enabled.", enabled:false};

  const vbc_type = document.getElementById("vbc_type")?.value || "earnback";
  const at_risk = parseFloat(document.getElementById("vbc_at_risk")?.value)||0;
  const baseline = parseFloat(document.getElementById("vbc_baseline")?.value)||0;
  const projected = parseFloat(document.getElementById("vbc_projected")?.value)||0;

  let earn = 0;
  let detail = "";

  if(vbc_type === "earnback"){
    const delta = Math.max(0, projected - baseline);
    earn = (delta / 100) * at_risk;
    detail = `Linear earn-back model:\n- At-risk pool: ${fmtMoney(at_risk)}\n- Baseline score: ${baseline}\n- Projected score: ${projected}\n- Delta: +${delta} points\n- Incremental earn-back: ${fmtMoney(earn)}\n\nAffected measures: Diabetes Glycemic Status (QPP 001), Controlling High Blood Pressure (236), Colorectal Screening (113), Transitions of Care / Med Rec (Star Ratings).`;
  } else {
    const threshold = parseFloat(document.getElementById("vbc_threshold")?.value)||0;
    const bonus = parseFloat(document.getElementById("vbc_bonus")?.value)||0;
    const clears = projected >= threshold;
    const baseClears = baseline >= threshold;
    earn = clears && !baseClears ? bonus : 0;
    detail = `Cliff/threshold bonus model:\n- Threshold: ${threshold} | Bonus: ${fmtMoney(bonus)}\n- Baseline ${baseline} ${baseClears?"CLEARS":"misses"} threshold\n- Projected ${projected} ${clears?"CLEARS":"misses"} threshold\n- Incremental earn: ${fmtMoney(earn)}\n${!clears?"Note: Projected score does not reach threshold. Consider interventions to close remaining gap.":""}`;
  }
  return {earn, detail, enabled:true};
}

function render_roi(){
  const inp = roi_inputs();
  const out = roi_calc(inp);

  // Base KPI outputs (Excel parity)
  document.getElementById("o_net").textContent = "$" + out.net_benefit.toLocaleString(undefined,{maximumFractionDigits:0});
  document.getElementById("o_tripmax").textContent = "$" + out.be_trip_max.toFixed(0);
  document.getElementById("o_cost").textContent = "$" + out.total_program_cost.toLocaleString(undefined,{maximumFractionDigits:0});

  // Coding uplift (optional)
  const cu = coding_uplift(out.prevented, inp.visits);
  document.getElementById("o_code").textContent = "$" + cu.uplift.toLocaleString(undefined,{maximumFractionDigits:0});

  const totalNet = out.net_benefit + cu.uplift;
  document.getElementById("o_total_net").textContent = "$" + totalNet.toLocaleString(undefined,{maximumFractionDigits:0});

  const roiTotal = (out.total_program_cost===0) ? 0 : (totalNet / out.total_program_cost);
  document.getElementById("o_roi").textContent = (out.total_program_cost===0) ? "—" : roiTotal.toFixed(2) + "x";

  // CCM/TCM Layer
  const cct = ccm_tcm_calc();
  document.getElementById("o_ccm_net").textContent = cct.enabled ? fmtMoney(cct.ccm_net) : "—";
  document.getElementById("o_tcm_net").textContent = cct.enabled ? fmtMoney(cct.tcm_net) : "—";

  // VBC Layer
  const vbc = vbc_calc();
  document.getElementById("o_vbc_earn").textContent = vbc.enabled ? fmtMoney(vbc.earn) : "—";

  // All-in
  const allin = totalNet + (cct.enabled ? cct.ccm_net + cct.tcm_net : 0) + (vbc.enabled ? vbc.earn : 0);
  document.getElementById("o_allin").textContent = fmtMoney(allin);

  // Waterfall chart
  const wfCtx = document.getElementById("roi_waterfall");
  if(wfCtx){
    if(wfCtx._chart){ wfCtx._chart.destroy(); }
    wfCtx._chart = new Chart(wfCtx, {
      type:"bar",
      data:{
        labels:["Gross Revenue\nRecaptured","Marginal\nClinical Cost","Program\nCost","FFS Net\nBenefit","Coding\nUplift","CCM\nNet","TCM\nNet","VBC\nEarn-back","All-in\nValue"],
        datasets:[{
          data:[out.gross_rev, -out.marginal_cost, -out.total_program_cost, out.net_benefit, cu.uplift, cct.enabled?cct.ccm_net:0, cct.enabled?cct.tcm_net:0, vbc.enabled?vbc.earn:0, allin],
          backgroundColor:["#14b8a6","#ef4444","#ef4444","#0f2b46","#64748b","#2563eb","#3b82f6","#059669","#0d9488"],
          borderRadius:6,
          borderSkipped:false
        }]
      },
      options:{
        plugins:{legend:{display:false}},
        scales:{y:{ticks:{callback:(v)=>"$"+Math.round(v/1000)+"K"}}},
        responsive:true
      }
    });
  }

  // Value stack bar chart
  const ctx = document.getElementById("roi_bar");
  if(ctx){
    if(ctx._chart){ ctx._chart.destroy(); }
    const labels = ["FFS Base"];
    const vals = [out.net_benefit];
    const colors = ["#0f2b46"];
    if(cu.uplift>0){ labels.push("+ Coding"); vals.push(cu.uplift); colors.push("#64748b"); }
    if(cct.enabled){ labels.push("+ CCM"); vals.push(cct.ccm_net); colors.push("#2563eb"); labels.push("+ TCM"); vals.push(cct.tcm_net); colors.push("#3b82f6"); }
    if(vbc.enabled){ labels.push("+ VBC"); vals.push(vbc.earn); colors.push("#059669"); }
    ctx._chart = new Chart(ctx, {
      type:"bar",
      data:{labels, datasets:[{data:vals, backgroundColor:colors, borderRadius:6}]},
      options:{plugins:{legend:{display:false}}, scales:{y:{ticks:{callback:(v)=>"$"+Math.round(v/1000)+"K"}}}, responsive:true}
    });
  }

  // CRA outputs
  const craTxt =
`Trips delivered (round trips): ${Math.round(out.trips).toLocaleString()}
LMI trips: ${Math.round(out.lmi_trips).toLocaleString()}
AA trips: ${Math.round(out.aa_trips).toLocaleString()}

Bank annual contribution: $${inp.bank.toLocaleString()}
Bank contribution per LMI trip: $${out.bank_per_lmi.toFixed(0)}
Share of total program cost funded by Bank: ${(out.bank_share_cost*100).toFixed(1)}%

Narrative-ready summary:
${out.narrative}`;
  document.getElementById("cra_box").textContent = craTxt;

  // Extended layers detail
  const extBox = document.getElementById("extended_layers_box");
  if(extBox){
    let extTxt = "";
    if(cct.enabled) extTxt += cct.detail + "\n\n";
    else extTxt += "CCM/TCM Layer: not enabled.\n\n";
    if(vbc.enabled) extTxt += vbc.detail + "\n\n";
    else extTxt += "VBC Quality Layer: not enabled.\n\n";
    extTxt += `All-in Value Summary:\n- FFS base net: ${fmtMoney(out.net_benefit)}\n- Coding uplift: ${fmtMoney(cu.uplift)}\n- CCM net: ${cct.enabled ? fmtMoney(cct.ccm_net) : "—"}\n- TCM net: ${cct.enabled ? fmtMoney(cct.tcm_net) : "—"}\n- VBC earn-back: ${vbc.enabled ? fmtMoney(vbc.earn) : "—"}\n- All-in value: ${fmtMoney(allin)}`;
    extBox.textContent = extTxt;
  }

  // Audit memo
  document.getElementById("roi_audit").textContent =
`Tier 3 — Excel-parity ROI + Optional Layers

Base ROI (Excel parity):
- Net benefit: $${out.net_benefit.toFixed(0)}
- Total program cost: $${out.total_program_cost.toFixed(0)}
- Break-even trip cost max: $${out.be_trip_max.toFixed(0)}

Coding ROI Layer:
${cu.detail}

CCM/TCM Layer:
${cct.detail}

VBC Quality Layer:
${vbc.detail}

All-in net (all enabled layers): ${fmtMoney(allin)}
ROI incl. coding: ${out.total_program_cost===0 ? "—" : roiTotal.toFixed(2)+"x"}

Generated: ${new Date().toISOString()}`;

  // persist for draft generator
  state.model = { roi_parity:true, inputs: inp, outputs: out, coding: cu, totalNet, roiTotal, ccm_tcm: cct, vbc, allin };
}


(function(){
  const t = document.getElementById("toggle_coding");
  const box = document.getElementById("coding_box");
  if(t && box){
    t.addEventListener("change", ()=>{ box.style.display = t.checked ? "block" : "none"; });
  }
})();


// ------------------------------
// Tier 3 Coding layer UX: recompute on toggle/input changes
// ------------------------------
(function(){
  const t = document.getElementById("toggle_coding");
  const box = document.getElementById("coding_box");
  if(t && box){
    const sync = ()=>{ box.style.display = t.checked ? "block" : "none"; };
    sync();
    t.addEventListener("change", ()=>{ sync(); if(typeof render_roi === "function") render_roi(); });
    ["z_rate","z_uplift","cpt_rate","cpt_uplift","coding_base"].forEach(id=>{
      const el = document.getElementById(id);
      if(el) el.addEventListener("change", ()=>{ if(typeof render_roi === "function") render_roi(); });
      if(el) el.addEventListener("input", ()=>{ if(typeof render_roi === "function") render_roi(); });
    });
  }
})();

// CCM/TCM toggle
(function(){
  const t = document.getElementById("toggle_ccm");
  const box = document.getElementById("ccm_box");
  if(t && box){
    t.addEventListener("change", ()=>{ box.style.display = t.checked ? "block" : "none"; });
  }
})();

// VBC toggle
(function(){
  const t = document.getElementById("toggle_vbc");
  const box = document.getElementById("vbc_box");
  const cliff = document.getElementById("vbc_cliff_row");
  if(t && box){
    t.addEventListener("change", ()=>{ box.style.display = t.checked ? "block" : "none"; });
  }
  const typeEl = document.getElementById("vbc_type");
  if(typeEl && cliff){
    typeEl.addEventListener("change", ()=>{
      cliff.style.display = typeEl.value === "cliff" ? "flex" : "none";
    });
  }
})();

// ------------------------------
// Tier 4-6 generators (prototype content)
// ------------------------------
window.copy_block = async function(id){
  const el = document.getElementById(id);
  if(!el) return;
  const txt = el.textContent || "";
  try{ await navigator.clipboard.writeText(txt); showOk("Copied."); }catch(e){ showOk("Copy not available; select text manually."); }
};

window.generate_impl_plan = function(){
  const opp = state.opportunities?.[0];
  const m = state.model?.outputs;
  const txt =
`Implementation Plan (30-60-90)

Selected opportunity: ${opp ? opp.opp : "—"}
CRA criterion satisfied: ${opp ? opp.criterion : "—"}

0–30 days
- Confirm target geography and eligible population (LMI method) and document AA attribution.
- Finalize partner/vendor and service workflow (scheduling, eligibility, ride confirmation, documentation).
- Build the evidence packet template (contracts, invoices, ride logs, beneficiary counts).

31–60 days
- Launch pilot; begin weekly operational monitoring.
- Collect ride logs, completed visits enabled, cancellations/no-shows, and beneficiary ZIP/tract.
- Produce first monthly report: volumes, costs, and exceptions.

61–90 days
- Compare baseline vs observed: transport-related no-shows prevented.
- Adjust workflow; document corrective actions.
- Produce quarterly outcomes report for CRA file and hospital leadership.

${m ? "\nCurrent ROI baseline:\n- Prevented no-shows: "+Math.round(m.prevented).toLocaleString()+"\n- Net benefit: "+fmtMoney(m.net_benefit) : ""}`;
  document.getElementById("impl_plan").textContent = txt;
};

window.generate_outcomes_report = function(){
  const opp = state.opportunities?.[0];
  const m = state.model?.outputs;
  const txt =
`Quarterly Outcomes Report Template

Project: ${opp ? opp.opp : "—"}
Reporting period: ___________________

Operational Outputs
- Trips delivered (round trips): ${m ? Math.round(m.trips).toLocaleString() : "—"}
- Completed visits enabled: ${m ? Math.round(m.prevented).toLocaleString() : "—"}
- Cancellation rate: _______
- On-time pickup rate: _______

Beneficiary & Scope (CRA)
- % LMI: _______   (method: _______)
- LMI trips: ${m ? Math.round(m.lmi_trips).toLocaleString() : "—"}
- % within AA: _______
- AA trips: ${m ? Math.round(m.aa_trips).toLocaleString() : "—"}

Financial (Hospital)
- Gross revenue recaptured: ${m ? fmtMoney(m.gross_rev) : "—"}
- Total program cost: ${m ? fmtMoney(m.total_program_cost) : "—"}
- Net annual benefit (base): ${m ? fmtMoney(m.net_benefit) : "—"}

Narrative
- Describe responsiveness to documented CHNA need and any adjustments made.
`;
  document.getElementById("outcomes_report").textContent = txt;
};

window.generate_eval_plan = function(){
  const opp = state.opportunities?.[0];
  const txt =
`Evaluation Plan Template

1) Purpose
Evaluate whether the intervention reduces transport-related missed appointments and improves access for the target population.

2) Baseline
- Baseline no-show rate (overall): _______
- Transport-attributable no-show share: _______
- CHNA evidence citations: ${state.findings?.slice(0,3).map(f=>f.evidenceRef).filter(Boolean).join("; ") || "—"}

3) Design
- Pre/post comparison (baseline period vs intervention period)
- Stratify by: age group (65–74), LMI status, and geography (AA)

4) Metrics
- Primary: prevented no-shows, trips delivered, completed visits enabled
- Secondary: downstream utilization proxies (optional), patient experience, timeliness
- CRA: LMI trips, AA trips, bank $/LMI trip

5) Data sources
- Scheduling system, ride logs, billing/RVUs, SDOH screening/Z-codes (if enabled)

6) Governance & cadence
- Weekly ops huddle, monthly reporting, quarterly executive review
- Corrective action triggers: missed pickup rate, high cancellations, documentation gaps

7) Deliverables
- Quarterly outcomes report
- Year-end evaluation report with lessons learned and scaling recommendation
`;
  document.getElementById("eval_plan").textContent = txt;
};


// ------------------------------
// Training Module JS
// ------------------------------
window.showExercise = function(n){
  document.querySelectorAll(".training-exercise").forEach(el=>el.classList.remove("active"));
  const ex = document.getElementById("ex_"+n);
  if(ex){ ex.classList.add("active"); ex.scrollIntoView({behavior:"smooth", block:"start"}); }
  document.querySelectorAll(".ex-nav-btn").forEach(btn=>{
    btn.classList.toggle("active", parseInt(btn.dataset.ex)===n);
  });
};

window.selectPred = function(exNum, choice){
  const container = document.getElementById("pred_"+exNum);
  if(!container) return;
  container.querySelectorAll(".pred-option").forEach((el,i)=>{
    const letters = "abcd";
    el.classList.remove("selected","correct","incorrect");
    if(letters[i]===choice) el.classList.add("selected");
  });
};

window.toggleReveal = function(id){
  const el = document.getElementById(id);
  if(!el) return;
  const showing = el.style.display !== "none";
  el.style.display = showing ? "none" : "block";
  // Mark options correct/incorrect when revealed
  const m = id.match(/pred_reveal_(\d+)/);
  if(!m || showing) return;
  const exNum = m[1];
  const correctMap = {"1":"b","2":"b","3":"c","4":"b","5":"c"};
  const correct = correctMap[exNum];
  const container = document.getElementById("pred_"+exNum);
  if(!container || !correct) return;
  const letters = "abcd";
  container.querySelectorAll(".pred-option").forEach((el,i)=>{
    if(letters[i]===correct){ el.classList.add("correct"); el.classList.remove("selected","incorrect"); }
    else if(el.classList.contains("selected")){ el.classList.add("incorrect"); el.classList.remove("selected"); }
  });
};


// Handle training tab click via existing tab wire-up (data-view="training" already wired above)
// showExercise, selectPred, toggleReveal are globally defined above


// ═══════════════════════════════════════════════════════════
// MAYO / ADVANCED CHNA MODULE JS
// ═══════════════════════════════════════════════════════════

window.mayoNav = function(panel) {
  ['chna','linkage','roi','cra','banks','draft'].forEach(p => {
    const el = document.getElementById('mpanel_' + p);
    if (el) el.style.display = (p === panel) ? 'block' : 'none';
  });
  document.querySelectorAll('.mayo-subnav').forEach(b => b.classList.remove('active-subnav'));
  const btn = document.getElementById('mn_' + panel);
  if (btn) btn.classList.add('active-subnav');
  if (panel === 'roi') { setTimeout(calcMayoROI, 60); }
};

window.toggleMEN = function(n) {
  const isOpen = document.getElementById('men'+n+'_body').style.display !== 'none';
  [1,2,3,4].forEach(i => {
    document.getElementById('men'+i+'_body').style.display = 'none';
    document.getElementById('men'+i+'_arr').textContent = '\u25B8';
  });
  if (!isOpen) {
    document.getElementById('men'+n+'_body').style.display = 'block';
    document.getElementById('men'+n+'_arr').textContent = '\u25BE';
  }
};

window.toggleMayoLayer = function(layer) {
  const box = document.getElementById('mr_' + layer + '_box');
  const chk = document.getElementById('mr_' + layer + '_on');
  if (box && chk) { box.style.display = chk.checked ? 'grid' : 'none'; calcMayoROI(); }
};

window.calcMayoROI = function() {
  function gv(id) { return parseFloat(document.getElementById(id) && document.getElementById(id).value) || 0; }
  function norm(v) { return v > 1 ? v / 100 : v; }
  const V=gv('mr_v'), n=norm(gv('mr_n')), s=norm(gv('mr_s')), m=norm(gv('mr_m'));
  const r=gv('mr_r'), c=gv('mr_c'), t=gv('mr_t'), o=norm(gv('mr_o'));
  const prevented = V*n*s*m;
  const gross = prevented*r, margCost = prevented*c, tripCost = prevented*t;
  const overhead = tripCost*o, progCost = tripCost+overhead;
  const ffsNet = gross - margCost - progCost;
  var rows = [
    {l:'Gross revenue ('+Math.round(prevented).toLocaleString()+' visits \xd7 $'+r+')', v:gross, c:'pos'},
    {l:'Marginal clinical cost', v:-margCost, c:'neg'},
    {l:'Trip cost (\xd7 $'+t+')', v:-tripCost, c:'neg'},
    {l:'Overhead ('+Math.round(o*100)+'%)', v:-overhead, c:'neg'},
    {l:'FFS Net Annual Benefit', v:ffsNet, c:'tot'}
  ];
  var totalNet = ffsNet;
  if (document.getElementById('mr_ccm_on') && document.getElementById('mr_ccm_on').checked) {
    var cp=gv('mr_cp'), ce=norm(gv('mr_ce')), td=gv('mr_td'), tr=norm(gv('mr_tr'));
    var ccmNet = cp*ce*8*62*0.85 - cp*ce*8*20*0.65;
    var tcmEp = td*tr*0.82;
    var tcmNet = tcmEp*(0.35*290+0.65*215) - tcmEp*45*0.65;
    var ccmInc = ccmNet*0.40;
    rows.push({l:'CCM net (\xd740% incremental)', v:ccmInc, c:'layer'});
    rows.push({l:'TCM net', v:tcmNet, c:'layer'});
    totalNet += ccmInc + tcmNet;
  }
  if (document.getElementById('mr_vbc_on') && document.getElementById('mr_vbc_on').checked) {
    var pool=gv('mr_pool'), base=gv('mr_base'), proj=gv('mr_proj'), bank=gv('mr_bank');
    var vbcNet = Math.max(0, ((proj-base)/100)*pool);
    rows.push({l:'VBC quality earn-back', v:vbcNet, c:'layer'});
    rows.push({l:'Bank CRA contribution', v:bank, c:'layer'});
    totalNet += vbcNet + bank;
  }
  if (rows.length > 5) { rows.push({l:'ALL-IN NET VALUE', v:totalNet, c:'tot'}); }
  var wf = document.getElementById('mayo_wf_rows');
  if (!wf) return;
  wf.innerHTML = rows.map(function(row) {
    var sign = row.v < 0 ? '-' : '';
    var disp = sign + '$' + Math.round(Math.abs(row.v)).toLocaleString();
    var bg = row.c==='pos' ? 'background:rgba(4,120,87,.07);border:1px solid rgba(4,120,87,.2);' :
             row.c==='neg' ? 'background:rgba(185,28,28,.07);border:1px solid rgba(185,28,28,.2);' :
             row.c==='tot' ? 'background:var(--navy);color:#fff;font-weight:700;' :
                             'background:rgba(13,148,136,.08);border:1px solid rgba(13,148,136,.2);';
    var vc = row.c==='tot' ? 'color:#A7F3D0;' : row.c==='pos' ? 'color:var(--green);' : row.c==='neg' ? 'color:var(--red);' : 'color:var(--teal);';
    return '<div style="display:flex;justify-content:space-between;align-items:center;padding:7px 12px;border-radius:7px;font-size:13px;'+bg+'"><span>'+row.l+'</span><span style="font-family:monospace;font-weight:700;'+vc+'">'+disp+'</span></div>';
  }).join('');
  var roi = progCost > 0 ? (totalNet/progCost).toFixed(2)+'x' : '\u2014';
  var beTrip = (r - c).toFixed(0);
  var roiEl=document.getElementById('mayo_roi_big'), netEl=document.getElementById('mayo_net_big'), beEl=document.getElementById('mayo_be_txt');
  if(roiEl) roiEl.textContent = roi;
  if(netEl) netEl.textContent = '$'+Math.round(Math.abs(totalNet)).toLocaleString()+' net annual value';
  if(beEl)  beEl.textContent  = 'Break-even trip cost: $'+beTrip+' | Program cost: $'+Math.round(progCost).toLocaleString()+'/yr';
};

window.updateCRATotal = function() {
  var amt = parseFloat(document.getElementById('cra_amount').value)||0;
  var term = parseFloat(document.getElementById('cra_term').value)||1;
  document.getElementById('cra_total').value = Math.round(amt*term);
};

window.generateMayoDraft = function(type) {
  var bank    = (document.getElementById('cra_bank').value||'[BANK NAME]');
  var actType = (document.getElementById('cra_acttype').value||'Qualified Charitable Contribution');
  var amount  = (document.getElementById('cra_amount').value||'75000');
  var term    = (document.getElementById('cra_term').value||'3');
  var total   = (document.getElementById('cra_total').value||'225000');
  var need    = (document.getElementById('cra_need').value||'');
  var activity= (document.getElementById('cra_activity').value||'');
  var lmi     = (document.getElementById('cra_lmi').value||'\u226480% AMI');
  var verify  = (document.getElementById('cra_verify').value||'Medicaid/CHIP enrollment');
  var outcomes= (document.getElementById('cra_outcomes').value||'');
  var rep     = (document.getElementById('cra_rep').value||'');
  var freq    = (document.getElementById('cra_reporting').value||'Quarterly');
  var today   = new Date().toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'});
  var doc = '';
  if (type === 'memo') {
    document.getElementById('mayo_draft_title').textContent = 'CRA Activity Justification Memo \u2014 Preview';
    doc = 'CONFIDENTIAL DRAFT \u2014 FOR LEGAL REVIEW BEFORE DISTRIBUTION\n'
        + '\u2501'.repeat(44)+'\n'
        + 'CRA COMMUNITY DEVELOPMENT ACTIVITY JUSTIFICATION MEMORANDUM\n'
        + '\u2501'.repeat(44)+'\n\n'
        + 'TO:    '+bank+' \u2014 Community Development / CRA Officer\n'
        + 'FROM:  Mayo Clinic in Rochester \u2014 Community Engagement Office\n'
        + 'DATE:  '+today+'\n'
        + 'RE:    Olmsted County NEMT Program \u2014 Rochester MSA Assessment Area\n\n'
        + '\u2501'.repeat(44)+'\n'
        + 'SECTION 1 \u2014 CHNA CITATION & COMMUNITY HEALTH NEED\n'
        + '\u2501'.repeat(44)+'\n\n'
        + 'CHNA Document:\n'
        + '  2025 Community Health Needs Assessment \u2014 Olmsted County, MN.\n'
        + '  Released October 7, 2025. Produced by Olmsted County Public Health\n'
        + '  Services, Mayo Clinic in Rochester, and Olmsted Medical Center.\n'
        + '  URL: storymaps.arcgis.com/collections/7651105f080c418891d71862b91ed210\n\n'
        + '2025 Priorities Addressed:\n'
        + '  #1 Access to Care \u2014 34% of adults delayed care; 15% lack a PCP;\n'
        + '     disability (9.7%) and foreign-born (11.1%) face transport barriers.\n'
        + '  #2 Mental Health  \u2014 37% prevalence; depression rate (28%) exceeds\n'
        + '     MN (23%) and U.S. (22%) benchmarks; renter/disability concentration.\n'
        + '  #3 Food Security  \u2014 33,000 Channel One clients; 23% Hispanic,\n'
        + '     14% Black; co-occurring transport-barrier population.\n\n'
        + 'Statement of Need:\n'+need+'\n\n'
        + '\u2501'.repeat(44)+'\n'
        + 'SECTION 2 \u2014 ACTIVITY DESCRIPTION & BANK ROLE\n'
        + '\u2501'.repeat(44)+'\n\n'
        + 'Activity Type: '+actType+'\n\n'
        + activity+'\n\n'
        + 'Assessment Area Confirmation:\n'
        + '  Rochester MSA CRA Assessment Area = all of Olmsted County +\n'
        + '  all of Dodge County, MN (OCC-confirmed). All program beneficiaries\n'
        + '  are Olmsted County residents served at Mayo Clinic facilities.\n\n'
        + '\u2501'.repeat(44)+'\n'
        + 'SECTION 3 \u2014 LMI POPULATION DOCUMENTATION\n'
        + '\u2501'.repeat(44)+'\n\n'
        + 'Eligibility Threshold: '+lmi+'\n'
        + 'Verification Method:   '+verify+'\n'
        + 'Olmsted County median HH income: $87,856 (2023 Census)\n'
        + 'Poverty rate: 7.9% (~13,000 residents below poverty threshold)\n\n'
        + 'Special Populations (2025 CHNA-documented):\n'
        + '  \u2022 Adults with disabilities: 9.7% of Olmsted County (~16,000)\n'
        + '  \u2022 Foreign-born residents: 11.1% \u2014 language/navigation barriers\n'
        + '  \u2022 Renters: higher mental health disparities + transport dependence\n'
        + '  \u2022 Uninsured: Salvation Army Good Samaritan Clinic (4,000+ patients)\n'
        + '  \u2022 LGBTQIA+ residents: documented access disparities\n\n'
        + '\u2501'.repeat(44)+'\n'
        + 'SECTION 4 \u2014 MEASURABLE OUTCOMES & REPORTING\n'
        + '\u2501'.repeat(44)+'\n\n'
        + outcomes+'\n\n'
        + 'Rochester Epidemiology Project Study Design:\n'
        + rep+'\n\n'
        + 'Reporting to Bank: '+freq+'\n'
        + '  Reports formatted for CRA exam file use; delivered within 30 days\n'
        + '  of each reporting period end.\n\n'
        + '\u2501'.repeat(44)+'\n'
        + 'SECTION 5 \u2014 FINANCIAL STRUCTURE\n'
        + '\u2501'.repeat(44)+'\n\n'
        + 'Annual bank contribution:  $'+parseInt(amount).toLocaleString()+'\n'
        + 'Commitment term:           '+term+' year(s)\n'
        + 'Total commitment:          $'+parseInt(total).toLocaleString()+'\n'
        + 'Activity type (CRA file):  '+actType+'\n\n'
        + 'CRA Bank Benefit Statement:\n'
        + '  This contribution supports the Olmsted County NEMT program,\n'
        + '  a community development activity responding to the Access to\n'
        + '  Care priority (#1) in the 2025 Olmsted County CHNA. The program\n'
        + '  serves LMI/disability populations within the Rochester MSA CRA\n'
        + '  Assessment Area. Includes a Rochester Epidemiology Project outcomes\n'
        + '  study generating peer-reviewed evidence on NEMT effectiveness.\n'
        + '  '+freq+' reporting provided to support the bank\'s CRA exam file.\n\n'
        + '\u2501'.repeat(44)+'\n'
        + 'DISCLAIMER: Draft for internal review only. Not legal advice.\n'
        + 'Verify CRA eligibility with bank counsel before executing agreements.\n'
        + 'Generated: '+today+' via CHNA-CRA Compliance Navigator';
  } else {
    document.getElementById('mayo_draft_title').textContent = 'Bank Term Sheet / Pitch Brief \u2014 Preview';
    doc = 'CONFIDENTIAL DRAFT \u2014 FOR LEGAL REVIEW BEFORE DISTRIBUTION\n'
        + '\u2501'.repeat(44)+'\n'
        + 'NEMT PROGRAM PARTNERSHIP \u2014 TERM SHEET SUMMARY\n'
        + 'Rochester MSA CRA Assessment Area\n'
        + '\u2501'.repeat(44)+'\n\n'
        + 'Program:      Olmsted County Non-Emergency Medical Transportation (NEMT)\n'
        + 'Institution:  Mayo Clinic in Rochester, MN\n'
        + 'Bank Partner: '+bank+'\n'
        + 'Date:         '+today+'\n\n'
        + 'COMMUNITY HEALTH NEED\n'
        + '  Source: 2025 Olmsted County CHNA (released Oct 7, 2025)\n'
        + '  Priority #1: Access to Care \u2014 34% of adults delayed care;\n'
        + '  transport barriers documented for disability and foreign-born\n'
        + '  populations. Rochester MSA Assessment Area confirmed as program\n'
        + '  service geography.\n\n'
        + 'WHY THIS QUALIFIES FOR CRA CREDIT\n'
        + '  Activity type:   '+actType+'\n'
        + '  CRA criterion:   Community Development Services for LMI individuals \u2014\n'
        + '                   transportation to medical treatments\n'
        + '                   (12 CFR 25.04(c)(3) Topic L)\n'
        + '  Assessment Area: All of Olmsted County + all of Dodge County, MN\n'
        + '                   (OCC-confirmed Rochester MSA CRA Assessment Area)\n'
        + '  LMI eligibility: '+lmi+' | Verification: '+verify+'\n\n'
        + 'WHAT MAKES THIS INVESTMENT EXCEPTIONAL\n'
        + '  1. Mayo Clinic anchor \u2014 largest employer in Olmsted County;\n'
        + '     marquee relationship for any CRA exam file\n'
        + '  2. Three CHNA priorities addressed: Access to Care, Mental Health,\n'
        + '     and Food Security (all documented in 2025 CHNA)\n'
        + '  3. Rochester Epidemiology Project study \u2014 peer-reviewed publication\n'
        + '     of NEMT outcomes using REP linked records; first of its kind\n'
        + '  4. Quarterly outcomes reporting formatted for CRA exam use\n'
        + '  5. Multi-year commitment \u2014 consistent qualifying activity across\n'
        + '     bank CRA exam cycles\n\n'
        + 'FINANCIAL TERMS\n'
        + '  Annual contribution:  $'+parseInt(amount).toLocaleString()+'\n'
        + '  Commitment term:      '+term+' year(s)\n'
        + '  Total commitment:     $'+parseInt(total).toLocaleString()+'\n'
        + '  Reporting:            '+freq+'\n\n'
        + 'PROGRAM OUTCOMES COMMITMENT\n'
        + outcomes.split('\n').map(function(l){return '  '+l;}).join('\n')+'\n\n'
        + 'NEXT STEPS\n'
        + '  1. Bank CRA Officer confirms preliminary interest (2 business days)\n'
        + '  2. Mayo Clinic Community Engagement Office schedules working meeting\n'
        + '  3. Bank submits to counsel for CRA activity qualification review\n'
        + '  4. Term sheet finalized; formal agreement executed\n\n'
        + '\u2501'.repeat(44)+'\n'
        + 'Discussion only. Does not create binding obligations.\n'
        + 'Verify CRA eligibility with bank counsel before execution.\n'
        + 'Generated: '+today+' via CHNA-CRA Compliance Navigator';
  }
  document.getElementById('mayo_draft_content').textContent = doc;
  document.getElementById('mayo_draft_out').style.display = 'block';
  document.getElementById('mayo_draft_out').scrollIntoView({behavior:'smooth',block:'start'});
};

window.copyMayoDraft = async function() {
  var txt = document.getElementById('mayo_draft_content').textContent||'';
  try { await navigator.clipboard.writeText(txt); showOk('Draft copied to clipboard.'); }
  catch(e) { showOk('Select text in the preview and copy manually.'); }
};

// Patch setView to hide grid for mayo tab too
(function(){
  var origSetView = window.setView;
  if (!origSetView) return;
  window.setView = function(view) {
    origSetView(view);
    var grid = document.querySelector('.grid.grid-2');
    if (grid && view === 'mayo') { grid.style.display = 'none'; setTimeout(calcMayoROI, 80); }
  };
})();

