import fs from "node:fs";
const { GSC_CLIENT_ID, GSC_CLIENT_SECRET, GSC_REFRESH_TOKEN } = process.env;
const tr = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ client_id: GSC_CLIENT_ID, client_secret: GSC_CLIENT_SECRET, refresh_token: GSC_REFRESH_TOKEN, grant_type: "refresh_token" }),
});
const tok = (await tr.json()).access_token;
if (!tok) throw new Error("token refresh failed");
const site = encodeURIComponent("https://wellows.com/");
async function q(body) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(`https://www.googleapis.com/webmasters/v3/sites/${site}/searchAnalytics/query`, {
      method: "POST", headers: { authorization: "Bearer " + tok, "content-type": "application/json" }, body: JSON.stringify(body),
    });
    if (r.status === 429 || r.status >= 500) { await new Promise((s) => setTimeout(s, 2000 * (attempt + 1))); continue; }
    const j = await r.json();
    if (j.error) throw new Error("GSC error: " + JSON.stringify(j.error).slice(0, 300));
    return j;
  }
  throw new Error("GSC retries exhausted");
}
async function pullAll(body) {
  const rows = [];
  for (let start = 0; start < 30 * 25000; start += 25000) {
    const j = await q({ ...body, rowLimit: 25000, startRow: start });
    const rr = j.rows ?? [];
    rows.push(...rr);
    if (rr.length < 25000) break;
  }
  return rows;
}
const RANGE = { startDate: "2026-01-27", endDate: "2026-07-26", type: "web" };
const out = { range: RANGE, pulledAt: new Date().toISOString() };
out.totals = (await q({ ...RANGE, rowLimit: 1 })).rows?.[0] ?? null;
console.log("totals:", JSON.stringify(out.totals));
out.byDate = (await q({ ...RANGE, dimensions: ["date"], rowLimit: 250 })).rows.map((r) => [r.keys[0], r.impressions, r.clicks]);
console.log("byDate days:", out.byDate.length);
out.queries = (await pullAll({ ...RANGE, dimensions: ["query"] })).map((r) => [r.keys[0], r.impressions, r.clicks, r.position]);
console.log("queries:", out.queries.length);
const MONTHS = [["2026-01-27","2026-01-31","2026-01"],["2026-02-01","2026-02-28","2026-02"],["2026-03-01","2026-03-31","2026-03"],["2026-04-01","2026-04-30","2026-04"],["2026-05-01","2026-05-31","2026-05"],["2026-06-01","2026-06-30","2026-06"],["2026-07-01","2026-07-26","2026-07"]];
out.monthlyQueries = {};
for (const [s, e, label] of MONTHS) {
  const rows = await pullAll({ startDate: s, endDate: e, type: "web", dimensions: ["query"] });
  out.monthlyQueries[label] = rows.map((r) => [r.keys[0], r.impressions, r.clicks]);
  console.log("month", label, "queries:", rows.length);
}
out.queryPage = (await pullAll({ ...RANGE, dimensions: ["query", "page"] })).map((r) => [r.keys[0], r.keys[1], r.impressions, r.clicks, r.position]);
console.log("queryPage rows:", out.queryPage.length);
fs.writeFileSync("/tmp/authority/gsc.json", JSON.stringify(out));
console.log("WROTE /tmp/authority/gsc.json", (fs.statSync("/tmp/authority/gsc.json").size / 1e6).toFixed(1), "MB");
