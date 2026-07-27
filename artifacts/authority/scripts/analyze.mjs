import fs from "node:fs";
const A = "/tmp/authority";
const gsc = JSON.parse(fs.readFileSync(`${A}/gsc.json`, "utf8"));
const bingQRows = JSON.parse(fs.readFileSync(`${A}/bing_query.json`, "utf8"));
const bingPRows = JSON.parse(fs.readFileSync(`${A}/bing_pages.json`, "utf8"));
const bingPQ = JSON.parse(fs.readFileSync(`${A}/bing_page_query.json`, "utf8"));
const ga4 = JSON.parse(fs.readFileSync(`${A}/ga4.json`, "utf8"));
const links = JSON.parse(fs.readFileSync(`${A}/links.json`, "utf8"));

const normQ = (s) => (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
function normPath(u) {
  let p = u ?? "";
  try { if (/^https?:\/\//i.test(p)) p = new URL(p).pathname; } catch {}
  p = p.split("#")[0].split("?")[0];
  try { p = decodeURIComponent(p); } catch {}
  p = p.replace(/\/{2,}/g, "/");
  if (p.length > 1) p = p.replace(/\/+$/, "");
  return (p || "/").toLowerCase();
}
const nWords = (q) => q.split(" ").filter(Boolean).length;
function gini(vals) {
  const v = vals.filter((x) => x > 0).sort((a, b) => a - b);
  const n = v.length; if (!n) return null; if (n === 1) return 0;
  const sum = v.reduce((a, b) => a + b, 0);
  let acc = 0; for (let i = 0; i < n; i++) acc += (i + 1) * v[i];
  return +(((2 * acc) / (n * sum)) - (n + 1) / n).toFixed(3);
}
const depthOf = (p) => (p === "/" ? 0 : p.split("/").filter(Boolean).length);

// ---------- rules ----------
const JUNK = ['["\\u201c\\u201d]', "(^|\\s)(site|inurl|intitle|filetype|inbody|url|ip|loc|feed|hasfeed|prefer|contains|language):", "\\)\\s+(and|or)\\s+\\("];
const junkRes = JUNK.map((s) => new RegExp(s, "i"));
const isJunk = (q) => junkRes.some((re) => re.test(q));
const ENG = "(ai|llms?|chatgpt|chat gpt|perplexity|gemini|copilot|claude|grok|ai overviews?|ai mode|ai search(es)?|generative)";
const RULES_A = [
  { id: "A1", note: "<engine> visibility", all: ["\\b(ai|llms?|chatgpt|chat gpt|perplexity|gemini|copilot|claude|grok|ai overviews?|ai search|generative engine)\\s+(search\\s+)?visibility\\b"] },
  { id: "A2", note: "visible/visibility in <engine>", all: [`\\bvisib\\w*\\s+(in|on|across|for|to)\\s+${ENG}\\b`] },
  { id: "A3", note: "brand visibility + engine term", all: ["\\bbrand\\s+visibility\\b", `\\b${ENG}\\b`] },
  { id: "A4", note: "<engine> brand monitoring/tracking/mentions", all: ["\\b(ai|llm|chatgpt|chat gpt|perplexity|gemini|copilot|claude|grok)\\s+brand\\s+(monitor(ing)?|track(ing|er)?|mentions?)\\b"] },
  { id: "A5", note: "brand/ai/llm mentions + engine term", all: ["\\b(brand|ai|llm)\\s+mentions?\\b", `\\b${ENG}\\b`] },
  { id: "A6", note: "track/monitor brand in <engine>", all: ["\\b(track|monitor|measure|check|audit|improve|increase|boost)\\w*\\b", "\\bbrand\\b", "\\b(in|on|across)\\s+(ai|chatgpt|chat gpt|perplexity|gemini|copilot|claude|grok|llms?|ai search|ai overviews?)\\b"] },
  { id: "A7", note: "<engine> tracker/tracking/monitoring", all: ["\\b(chatgpt|chat gpt|perplexity|gemini|copilot|claude|grok|llm|ai overviews?)\\s+(visibility\\s+)?(tracker|tracking|monitor(ing)?)\\b"] },
  { id: "A8", note: "share of voice + engine term", all: ["\\bshare of voice\\b", `\\b${ENG}\\b`] },
  { id: "A9", note: "ai/llm presence", all: ["\\b(ai|llm|chatgpt|chat gpt)\\s+presence\\b"] },
];
const RULES_B = [
  { id: "B1", note: "generative engine/search/ai optimization", all: ["\\bgenerative\\s+(engine|search|ai)\\s+optimi[sz]ation\\b"] },
  { id: "B2", note: "answer engine optimization", all: ["\\banswer\\s+engine\\s+optimi[sz]ation\\b"] },
  { id: "B3", note: "aeo (acronym)", all: ["\\baeo\\b"] },
  { id: "B4", note: "llm/ai/<engine> seo", all: ["\\b(llm|ai|chatgpt|chat gpt|perplexity|gemini|generative)\\s+seo\\b"] },
  { id: "B5", note: "seo for <engine>", all: ["\\bseo\\s+for\\s+(ai|llms?|chatgpt|chat gpt|perplexity|gemini|ai overviews?|ai search)\\b"] },
  { id: "B6", note: "optimize (for) <engine>", all: ["\\boptimi[sz]\\w+\\s+(content\\s+|website\\s+|site\\s+|brand\\s+|pages?\\s+)?for\\s+(chatgpt|chat gpt|perplexity|gemini|copilot|claude|grok|ai overviews?|ai mode|ai search|llms?|generative)\\b"] },
  { id: "B7", note: "rank in/on <engine>", all: ["\\brank(ing)?\\s+(in|on)\\s+(chatgpt|chat gpt|perplexity|gemini|ai overviews?|ai mode|ai search)\\b"] },
  { id: "B8", note: "llm/ai/chatgpt seeding", all: ["\\b(llm|ai|chatgpt|chat gpt)\\s+seeding\\b"] },
  { id: "B9", note: "ai overview/mode/search optimization", all: ["\\bai\\s+(overview s?|overviews?|mode|search)\\s+optimi[sz]ation\\b"] },
];
const GEO_TOKEN = /\bgeo\b/;
const GEO_MARKERS = "\\b(locat\\w+|target\\w+|geotag\\w*|maps?|fenc\\w+|ip|vpn|dns|cdn|cach\\w+|coordinat\\w+|latitude|longitude|geograph\\w+|geolocation|restrict\\w+|block\\w+|country|countries|region\\w*|city|cities|local|zip|postal|gps|political|weather|news|domination|dominance)\\b";
const GEO_BCTX = "\\b(seo|aeo|sem|generative|engine|optimi[sz]\\w+|llms?|ai|chatgpt|perplexity|gemini|copilot|claude|marketing|agenc\\w+|consult\\w+|content|strateg\\w+|rank\\w*|answer|checklist|audit|tools?|software|course|guide|vs|versus|seeding|brand\\w*)\\b";
const geoMarkersRe = new RegExp(GEO_MARKERS, "i");
const geoBctxRe = new RegExp(GEO_BCTX, "i");
const compile = (rs) => rs.map((r) => ({ ...r, res: r.all.map((s) => new RegExp(s, "i")) }));
const CA = compile(RULES_A), CB = compile(RULES_B);
const hitAny = (rs, q) => rs.some((r) => r.res.every((re) => re.test(q)));

const clsCache = new Map();
// returns: junk | A | B | both | geoCollision | geoAmbiguous | none
function classify(raw) {
  const q = normQ(raw);
  if (clsCache.has(q)) return clsCache.get(q);
  let out;
  if (isJunk(q)) out = "junk";
  else {
    const a = hitAny(CA, q);
    let b = hitAny(CB, q);
    let geoFlag = null;
    if (!b && GEO_TOKEN.test(q)) {
      if (geoMarkersRe.test(q)) geoFlag = "geoCollision";
      else if (geoBctxRe.test(q)) b = true; // rule B10
      else geoFlag = "geoAmbiguous";
    }
    if (a && b) out = "both";
    else if (a) out = "A";
    else if (b) out = "B";
    else if (geoFlag) out = geoFlag;
    else out = "none";
  }
  clsCache.set(q, out);
  return out;
}
const inEntity = (cls, e) => cls === e || cls === "both";

const INTENT = {
  compare: "\\b(best|top|vs|versus|alternatives?|reviews?|comparison|compared|difference between)\\b",
  buy: "\\b(tools?|software|platforms?|agenc(y|ies)|services?|pricing|price|cost|buy|hire|demo|trial|sign ?up|vendors?|consultants?|audit|api)\\b",
  do: "\\b(how to|checklist|guide|template|steps|tips|strateg(y|ies)|examples?|tutorial|framework|implement\\w*|measure|track|improve|increase|boost|optimi[sz]e)\\b",
};
const intentRes = Object.fromEntries(Object.entries(INTENT).map(([k, v]) => [k, new RegExp(v, "i")]));
function intentOf(q) {
  if (intentRes.compare.test(q)) return "compare";
  if (intentRes.buy.test(q)) return "buy";
  if (intentRes.do.test(q)) return "do";
  return "know";
}

// ---------- GOOGLE ----------
const gQueries = gsc.queries.map(([q, i, c, p]) => ({ q: normQ(q), i, c, p, cls: classify(q) }));
const junkG = gQueries.filter((r) => r.cls === "junk");
const geoColl = gQueries.filter((r) => r.cls === "geoCollision").map((r) => ({ q: r.q, i: r.i, engine: "google" }));
const geoAmb = gQueries.filter((r) => r.cls === "geoAmbiguous").map((r) => ({ q: r.q, i: r.i, engine: "google" }));
const unmatchedG = gQueries.filter((r) => r.cls === "none").sort((x, y) => y.i - x.i);

function entityQueryStats(rows, e) {
  const m = rows.filter((r) => inEntity(r.cls, e));
  const i = m.reduce((s, r) => s + r.i, 0), c = m.reduce((s, r) => s + r.c, 0);
  const posNum = m.reduce((s, r) => s + (r.p ?? 0) * r.i, 0);
  const lt = m.filter((r) => nWords(r.q) >= 4).reduce((s, r) => s + r.i, 0);
  const intents = { know: 0, compare: 0, buy: 0, do: 0 };
  for (const r of m) intents[intentOf(r.q)]++;
  return {
    queryDepth: m.length, impressions: i, clicks: c,
    ctr: i ? +(c / i * 100).toFixed(2) : null,
    wpos: i ? +(posNum / i).toFixed(1) : null,
    longTailShare: i ? +(lt / i * 100).toFixed(1) : null,
    intents, topQueries: m.sort((x, y) => y.i - x.i).slice(0, 8).map((r) => ({ q: r.q, i: r.i, c: r.c, pos: r.p ? +r.p.toFixed(1) : null })),
  };
}
const G = { A: entityQueryStats(gQueries, "A"), B: entityQueryStats(gQueries, "B") };

// pages per entity (google)
const qpRows = gsc.queryPage.map(([q, page, i, c, p]) => ({ q: normQ(q), path: normPath(page), i, c, p, cls: classify(q) }));
function entityPages(rows, e) {
  const per = new Map(); // path -> {i, commercial}
  for (const r of rows) {
    if (!inEntity(r.cls, e)) continue;
    const it = intentOf(r.q);
    const o = per.get(r.path) ?? { i: 0, comm: 0 };
    o.i += r.i;
    if (it === "buy" || it === "compare") o.comm += r.i;
    per.set(r.path, o);
  }
  const paths = [...per.entries()].map(([path, o]) => ({ path, i: o.i, commShare: o.i ? o.comm / o.i : 0, depth: depthOf(path) }));
  paths.sort((x, y) => y.i - x.i);
  const vals = paths.map((p) => p.i);
  const core = paths.filter((p) => p.commShare >= 0.5), outer = paths.filter((p) => p.commShare < 0.5);
  const dh = {}; for (const p of paths) dh[p.depth] = (dh[p.depth] ?? 0) + 1;
  return {
    pageSpread: paths.length, gini: gini(vals),
    avgDepth: paths.length ? +(paths.reduce((s, p) => s + p.depth, 0) / paths.length).toFixed(1) : null,
    depthHist: dh,
    core: { n: core.length, top: core.slice(0, 6).map((p) => ({ path: p.path, i: p.i })) },
    outer: { n: outer.length, top: outer.slice(0, 6).map((p) => ({ path: p.path, i: p.i })) },
    corePathSet: core.map((p) => p.path), outerPathSet: outer.map((p) => p.path),
    allPathSet: paths.map((p) => p.path),
  };
}
const GP = { A: entityPages(qpRows, "A"), B: entityPages(qpRows, "B") };

// monthly trend google
const monthsG = Object.keys(gsc.monthlyQueries).sort();
const trendG = { months: monthsG, A: { i: [], c: [] }, B: { i: [], c: [] } };
for (const mo of monthsG) {
  const rows = gsc.monthlyQueries[mo].map(([q, i, c]) => ({ q, i, c, cls: classify(q) }));
  for (const e of ["A", "B"]) {
    trendG[e].i.push(rows.filter((r) => inEntity(r.cls, e)).reduce((s, r) => s + r.i, 0));
    trendG[e].c.push(rows.filter((r) => inEntity(r.cls, e)).reduce((s, r) => s + r.c, 0));
  }
}

// ---------- BING ----------
const bAgg = new Map();
for (const r of bingQRows) {
  const q = normQ(r.query);
  const o = bAgg.get(q) ?? { q, i: 0, c: 0, posNum: 0, posDen: 0 };
  o.i += r.i; o.c += r.c;
  if (r.p != null && r.i > 0) { o.posNum += r.p * r.i; o.posDen += r.i; }
  bAgg.set(q, o);
}
const bQueries = [...bAgg.values()].filter((r) => r.i >= 1).map((r) => ({ q: r.q, i: r.i, c: r.c, p: r.posDen ? r.posNum / r.posDen : null, cls: classify(r.q) }));
const junkB = bQueries.filter((r) => r.cls === "junk");
for (const r of bQueries.filter((x) => x.cls === "geoCollision")) geoColl.push({ q: r.q, i: r.i, engine: "bing" });
for (const r of bQueries.filter((x) => x.cls === "geoAmbiguous")) geoAmb.push({ q: r.q, i: r.i, engine: "bing" });
const unmatchedB = bQueries.filter((r) => r.cls === "none").sort((x, y) => y.i - x.i);
function entityQueryStatsBing(rows, e) {
  const m = rows.filter((r) => inEntity(r.cls, e));
  const i = m.reduce((s, r) => s + r.i, 0), c = m.reduce((s, r) => s + r.c, 0);
  const wp = m.filter((r) => r.p != null);
  const posNum = wp.reduce((s, r) => s + r.p * r.i, 0), posDen = wp.reduce((s, r) => s + r.i, 0);
  const lt = m.filter((r) => nWords(r.q) >= 4).reduce((s, r) => s + r.i, 0);
  const intents = { know: 0, compare: 0, buy: 0, do: 0 };
  for (const r of m) intents[intentOf(r.q)]++;
  return {
    queryDepth: m.length, impressions: i, clicks: c,
    ctr: i ? +(c / i * 100).toFixed(2) : null,
    wpos: posDen ? +(posNum / posDen).toFixed(1) : null,
    longTailShare: i ? +(lt / i * 100).toFixed(1) : null,
    intents, topQueries: m.sort((x, y) => y.i - x.i).slice(0, 8).map((r) => ({ q: r.q, i: r.i, c: r.c, pos: r.p ? +r.p.toFixed(1) : null })),
  };
}
const B = { A: entityQueryStatsBing(bQueries, "A"), B: entityQueryStatsBing(bQueries, "B") };
// bing weekly trend
const weeks = [...new Set(bingQRows.map((r) => r.d))].sort();
const trendB = { weeks, A: { i: [], c: [] }, B: { i: [], c: [] } };
for (const w of weeks) {
  const rows = bingQRows.filter((r) => r.d === w);
  for (const e of ["A", "B"]) {
    const m = rows.filter((r) => inEntity(classify(r.query), e));
    trendB[e].i.push(m.reduce((s, r) => s + r.i, 0));
    trendB[e].c.push(m.reduce((s, r) => s + r.c, 0));
  }
}
// bing pages per entity from fanout
const bpqRows = [];
for (const [path, rows] of Object.entries(bingPQ.pages ?? {})) for (const r of rows) bpqRows.push({ q: normQ(r.q), path: normPath(path), i: r.i, c: r.c, cls: classify(r.q) });
const BP = { A: entityPages(bpqRows, "A"), B: entityPages(bpqRows, "B") };

// ---------- GA4 ----------
const hostTally = {};
for (const row of ga4.engagement.rows ?? []) { const h = row.dimensionValues[0].value; hostTally[h] = (hostTally[h] ?? 0) + Number(row.metricValues[0].value); }
const marketingHosts = Object.keys(hostTally).filter((h) => /^(www\.)?wellows\.com$/.test(h));
const engByPathEngine = new Map(); // key path|engine
const srcEngine = (src) => (/google/i.test(src) ? "google" : /bing/i.test(src) ? "bing" : "other");
for (const row of ga4.engagement.rows ?? []) {
  const [host, lp, src] = row.dimensionValues.map((d) => d.value);
  if (!marketingHosts.includes(host)) continue;
  const eng = srcEngine(src); if (eng === "other") continue;
  const key = normPath(lp) + "|" + eng;
  const o = engByPathEngine.get(key) ?? { sessions: 0, engaged: 0, dur: 0, conv: 0 };
  o.sessions += Number(row.metricValues[0].value);
  o.engaged += Number(row.metricValues[1].value);
  o.dur += Number(row.metricValues[2].value);
  engByPathEngine.set(key, o);
}
for (const row of ga4.keyEvents.rows ?? []) {
  const [lp, src] = row.dimensionValues.map((d) => d.value);
  const eng = srcEngine(src); if (eng === "other") continue;
  const key = normPath(lp) + "|" + eng;
  const o = engByPathEngine.get(key);
  if (o) o.conv += Number(row.metricValues[0].value) + Number(row.metricValues[1].value);
}
function ga4For(pathSet, engine) {
  let s = 0, e2 = 0, d = 0, cv = 0, pagesHit = 0;
  for (const p of pathSet) {
    const o = engByPathEngine.get(p + "|" + engine);
    if (!o) continue;
    pagesHit++; s += o.sessions; e2 += o.engaged; d += o.dur; cv += o.conv;
  }
  return { sessions: s, engagementRate: s ? +(e2 / s * 100).toFixed(1) : null, avgEngagementTime: s ? +(d / s).toFixed(0) : null, conversions: cv, pagesWithTraffic: pagesHit };
}
const GA = {
  A: { google: ga4For(GP.A.allPathSet, "google"), bing: ga4For(BP.A.allPathSet.length ? BP.A.allPathSet : GP.A.allPathSet, "bing") },
  B: { google: ga4For(GP.B.allPathSet, "google"), bing: ga4For(BP.B.allPathSet.length ? BP.B.allPathSet : GP.B.allPathSet, "bing") },
};

// ---------- links: outer feeding core ----------
const placTally = {};
for (const l of links) placTally[l.placement ?? "null"] = (placTally[l.placement ?? "null"] ?? 0) + 1;
const contentLinks = links.filter((l) => (l.placement ?? "content") === "content");
function feed(e) {
  const outer = new Set(GP[e].outerPathSet), core = new Set(GP[e].corePathSet);
  let n = 0; const srcs = new Set(); const anchors = [];
  for (const l of contentLinks) {
    const s = normPath(l.source_url), t = normPath(l.target_url);
    if (outer.has(s) && core.has(t)) { n++; srcs.add(s); if (anchors.length < 5 && l.anchor_text) anchors.push(l.anchor_text.slice(0, 60)); }
  }
  return { links: n, linkingOuterPages: srcs.size, sampleAnchors: anchors };
}
const linkFeed = { A: feed("A"), B: feed("B"), method: "content-placement internal links from outer (informational) to core (commercial) cluster pages, from the site link crawl" };

// ---------- both overlap ----------
const bothG = gQueries.filter((r) => r.cls === "both"), bothB = bQueries.filter((r) => r.cls === "both");

// ---------- gaps ----------
const corpus = { A: new Set(), B: new Set() };
for (const r of gQueries) for (const e of ["A", "B"]) if (inEntity(r.cls, e)) corpus[e].add(r.q);
for (const r of bQueries) for (const e of ["A", "B"]) if (inEntity(r.cls, e)) corpus[e].add(r.q);
const engines = ["chatgpt", "perplexity", "gemini", "copilot", "claude", "grok", "ai overviews?", "ai mode"];
const territories = [];
for (const en of engines) {
  territories.push({ entity: "A", label: en.replace("s?", "") + " visibility", terms: [en, "visibility"] });
  territories.push({ entity: "A", label: en.replace("s?", "") + " brand monitoring", terms: [en, "brand", "monitor\\w*"] });
}
for (const mod of ["pricing", "api", "benchmark\\w*", "case stud(y|ies)", "course", "certification", "for ecommerce", "for saas", "for b2b", "agenc(y|ies)"])
  territories.push({ entity: "A", label: "ai visibility " + mod.replace(/\\w\*|\(.*\)/g, "").trim(), terms: ["ai visibility", mod] });
for (const head of ["geo", "generative engine optimi[sz]ation", "aeo", "llm seo", "ai seo"])
  for (const mod of ["agenc(y|ies)", "tools?", "pricing", "course", "certification", "case stud(y|ies)", "for ecommerce", "for saas", "for b2b", "checklist", "audit", "api", "examples", "services"])
    territories.push({ entity: "B", label: (head.includes("optimi") ? "geo (full term)" : head) + " " + mod.replace(/\\w\*|\(.*\)|\?/g, "").trim().replace("(y|ies)", "y"), terms: [head, mod] });
for (const en of engines) territories.push({ entity: "B", label: "optimize for " + en.replace("s?", ""), terms: ["optimi[sz]\\w+", "for", en] });
function familyImpr(term) {
  const re = new RegExp("\\b" + term + "\\b", "i");
  let s = 0; for (const r of gQueries) if (r.cls !== "junk" && re.test(r.q)) s += r.i;
  return s;
}
const famCache = new Map();
const gaps = [];
for (const t of territories) {
  const res = t.terms.map((x) => new RegExp("\\b" + x + "\\b", "i"));
  let hit = false;
  for (const q of corpus[t.entity]) if (res.every((re) => re.test(q))) { hit = true; break; }
  if (!hit) {
    const fam = t.terms[0];
    if (!famCache.has(fam)) famCache.set(fam, familyImpr(fam));
    gaps.push({ ...t, familyImpr: famCache.get(fam) });
  }
}
gaps.sort((x, y) => y.familyImpr - x.familyImpr);

// ---------- assemble ----------
const lastFinal = gsc.byDate.filter((d) => d[1] > 0).map((d) => d[0]).sort().at(-1);
const sumQ = gQueries.reduce((s, r) => s + r.i, 0), sumQc = gQueries.reduce((s, r) => s + r.c, 0);
const bingPageTotal = bingPRows.reduce((s, r) => s + r.i, 0), bingQueryTotal = bQueries.reduce((s, r) => s + r.i, 0);
const out = {
  meta: {
    range: gsc.range, generatedAt: new Date().toISOString(), finalDataThrough: lastFinal,
    property: "https://wellows.com/ (URL-prefix, non-www)", ga4MarketingHosts: marketingHosts,
    sources: {
      google: "Google Search Console — Search Analytics API (finalized data, type=web). BigQuery bulk export requested but not available for this property (no export configured; no backfill exists) — stated per operator decision.",
      bing: "Bing Webmaster Tools API — GetQueryStats/GetPageStats weekly buckets (stored sync) + GetPageQueryStats live fan-out (177/177 pages).",
      ga4: "GA4 Data API (service account) — Organic Search sessions by landing page × source, host-filtered; key events merged by path.",
    },
    bingPageQueryCoverage: bingPQ.coverage ?? { total: 177, ok: Object.keys(bingPQ.pages ?? {}).length },
  },
  ruleset: { junk: JUNK, A: RULES_A, B: RULES_B, geo: { markers: GEO_MARKERS, bContext: GEO_BCTX, flow: "strong B stem wins; else geographic marker ⇒ excluded (collision); else GEO-context term ⇒ Entity B (rule B10); else ambiguous ⇒ excluded & listed" }, intent: { ...INTENT, precedence: "compare > buy > do > know" }, bothPolicy: "queries matching A and B rules count in BOTH clusters; overlap disclosed", urlNorm: "page URLs merged by canonical path (fragments/query strings stripped, fragments SUMMED)" },
  gapDisclosure: {
    google: { siteImpressions: gsc.totals.impressions, siteClicks: gsc.totals.clicks, queryVisibleImpressions: sumQ, queryVisibleClicks: sumQc, anonymizedImprShare: +((1 - sumQ / gsc.totals.impressions) * 100).toFixed(1), anonymizedClickShare: +((1 - sumQc / gsc.totals.clicks) * 100).toFixed(1) },
    bing: { pageLevelImpressions: bingPageTotal, queryLevelImpressions: bingQueryTotal, unreportedShare: bingPageTotal ? +((1 - bingQueryTotal / bingPageTotal) * 100).toFixed(1) : null },
  },
  junkStats: { google: { n: junkG.length, impressions: junkG.reduce((s, r) => s + r.i, 0) }, bing: { n: junkB.length, impressions: junkB.reduce((s, r) => s + r.i, 0) } },
  geoFlags: { collisions: geoColl.sort((x, y) => y.i - x.i).slice(0, 20), collisionCount: geoColl.length, ambiguous: geoAmb.sort((x, y) => y.i - x.i).slice(0, 20), ambiguousCount: geoAmb.length },
  entities: {
    A: { label: "AI Visibility", google: { ...G.A, pages: GP.A }, bing: { ...B.A, pages: BP.A }, ga4: GA.A },
    B: { label: "Generative Engine Optimization (GEO)", google: { ...G.B, pages: GP.B }, bing: { ...B.B, pages: BP.B }, ga4: GA.B },
  },
  bothOverlap: { google: { n: bothG.length, impressions: bothG.reduce((s, r) => s + r.i, 0) }, bing: { n: bothB.length, impressions: bothB.reduce((s, r) => s + r.i, 0) } },
  trends: { google: trendG, bing: trendB, monthNote: "2026-01 covers Jan 27–31 only; 2026-07 covers Jul 1–26 (final data)." },
  unmatched: { count: unmatchedG.length + unmatchedB.length, google: { count: unmatchedG.length, impressions: unmatchedG.reduce((s, r) => s + r.i, 0), top: unmatchedG.slice(0, 25).map((r) => ({ q: r.q, i: r.i })) }, bing: { count: unmatchedB.length, impressions: unmatchedB.reduce((s, r) => s + r.i, 0), top: unmatchedB.slice(0, 15).map((r) => ({ q: r.q, i: r.i })) } },
  gaps: gaps.slice(0, 10),
  linkFeed,
  placementValues: placTally,
};
fs.writeFileSync(`${A}/assessment.json`, JSON.stringify(out, null, 1));
fs.writeFileSync(`${A}/unmatched_full.json`, JSON.stringify({ google: unmatchedG.map((r) => ({ q: r.q, i: r.i, c: r.c })), bing: unmatchedB.map((r) => ({ q: r.q, i: r.i, c: r.c })) }));
fs.writeFileSync(`${A}/geo_flags_full.json`, JSON.stringify({ collisions: geoColl, ambiguous: geoAmb }));
fs.writeFileSync(`${A}/gaps_full.json`, JSON.stringify(gaps));
// ---------- sanity print ----------
const p = (o) => JSON.stringify(o);
console.log("GOOGLE A:", p({ depth: G.A.queryDepth, i: G.A.impressions, c: G.A.clicks, ctr: G.A.ctr, pos: G.A.wpos, lt: G.A.longTailShare, pages: GP.A.pageSpread, gini: GP.A.gini }));
console.log("GOOGLE B:", p({ depth: G.B.queryDepth, i: G.B.impressions, c: G.B.clicks, ctr: G.B.ctr, pos: G.B.wpos, lt: G.B.longTailShare, pages: GP.B.pageSpread, gini: GP.B.gini }));
console.log("BING   A:", p({ depth: B.A.queryDepth, i: B.A.impressions, c: B.A.clicks, pos: B.A.wpos, pages: BP.A.pageSpread }));
console.log("BING   B:", p({ depth: B.B.queryDepth, i: B.B.impressions, c: B.B.clicks, pos: B.B.wpos, pages: BP.B.pageSpread }));
console.log("GA4:", p(GA));
console.log("trendG months:", p(trendG.months), "A.i:", p(trendG.A.i), "B.i:", p(trendG.B.i));
console.log("trendG A.c:", p(trendG.A.c), "B.c:", p(trendG.B.c));
console.log("both:", p(out.bothOverlap), "junk:", p(out.junkStats), "geoFlags:", geoColl.length, geoAmb.length);
console.log("unmatched top10 G:", p(out.unmatched.google.top.slice(0, 10)));
console.log("gaps top10:", p(out.gaps.map((g) => g.entity + ":" + g.label + ":" + g.familyImpr)));
console.log("linkFeed:", p(linkFeed), "placements:", p(placTally));
console.log("ga4 hosts:", p(hostTally), "-> marketing:", p(marketingHosts));
console.log("intents A(G):", p(G.A.intents), "B(G):", p(G.B.intents));
console.log("core/outer A(G):", G.A ? p({ core: GP.A.core.n, outer: GP.A.outer.n }) : "", "B(G):", p({ core: GP.B.core.n, outer: GP.B.outer.n }));
console.log("topQ A(G):", p(G.A.topQueries.slice(0, 5)));
console.log("topQ B(G):", p(G.B.topQueries.slice(0, 5)));
