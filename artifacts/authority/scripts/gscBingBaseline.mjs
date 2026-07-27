const { GSC_CLIENT_ID, GSC_CLIENT_SECRET, GSC_REFRESH_TOKEN } = process.env;
const tr = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ client_id: GSC_CLIENT_ID, client_secret: GSC_CLIENT_SECRET, refresh_token: GSC_REFRESH_TOKEN, grant_type: "refresh_token" }),
});
const tok = (await tr.json()).access_token;
if (!tok) { console.log("GSC token refresh FAILED"); process.exit(1); }
const site = encodeURIComponent("https://wellows.com/");
async function q(body) {
  const r = await fetch(`https://www.googleapis.com/webmasters/v3/sites/${site}/searchAnalytics/query`, {
    method: "POST", headers: { authorization: "Bearer " + tok, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return r.json();
}
const range = { startDate: "2026-01-27", endDate: "2026-07-26", type: "web" };
const tot = await q({ ...range, rowLimit: 1 });
console.log("SITE TOTALS (no dims):", JSON.stringify(tot.rows ?? tot.error));
const byDate = await q({ ...range, dimensions: ["date"], rowLimit: 250 });
const m = {};
for (const r of byDate.rows ?? []) { const mo = r.keys[0].slice(0, 7); m[mo] ??= { i: 0, c: 0 }; m[mo].i += r.impressions; m[mo].c += r.clicks; }
console.log("MONTHLY (final data):", JSON.stringify(m));
let qi = 0, qc = 0, qn = 0, start = 0;
for (;;) {
  const b = await q({ ...range, dimensions: ["query"], rowLimit: 25000, startRow: start });
  const rr = b.rows ?? [];
  qn += rr.length;
  for (const r of rr) { qi += r.impressions; qc += r.clicks; }
  if (rr.length < 25000) break;
  start += 25000;
}
console.log("QUERY-DIM rows:", qn, "impr:", qi, "clicks:", qc, "| anonymized gap estimate vs totals available");
