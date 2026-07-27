import fs from "node:fs";
const apiKey = process.env.BING_WEBMASTER_API_KEY;
const paths = JSON.parse(fs.readFileSync("/tmp/authority/bing_paths.json", "utf8"));
const out = { fetchedAt: new Date().toISOString(), pages: {}, failures: [], skipped: false };
if (!apiKey || paths.length === 0 || paths.length > 260) {
  out.skipped = true;
  fs.writeFileSync("/tmp/authority/bing_page_query.json", JSON.stringify(out));
  console.log("SKIPPED fanout; paths:", paths.length, "key:", !!apiKey);
  process.exit(0);
}
function parseBingDate(raw) {
  const m = /\/Date\((\d+)([+-]\d{4})?\)\//.exec(raw ?? "");
  if (!m) return null;
  let ms = Number(m[1]);
  if (m[2]) { const sign = m[2][0] === "-" ? -1 : 1; const hh = Number(m[2].slice(1, 3)); const mm = Number(m[2].slice(3, 5)); ms += sign * (hh * 60 + mm) * 60000; }
  return new Date(ms).toISOString().slice(0, 10);
}
let fails = 0;
for (const p of paths) {
  const page = "https://wellows.com" + p;
  const url = `https://ssl.bing.com/webmaster/api.svc/json/GetPageQueryStats?siteUrl=${encodeURIComponent("https://wellows.com")}&page=${encodeURIComponent(page)}&apikey=${apiKey}`;
  try {
    const r = await fetch(url, { headers: { accept: "application/json" } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    const rows = (j.d ?? [])
      .map((row) => ({ q: row.Query, d: parseBingDate(row.Date), i: row.Impressions ?? 0, c: row.Clicks ?? 0, p: row.AvgImpressionPosition === -1 ? null : row.AvgImpressionPosition }))
      .filter((row) => row.q && row.d && row.d >= "2026-01-27" && row.d <= "2026-07-26");
    out.pages[p] = rows;
  } catch (e) {
    fails++;
    out.failures.push({ path: p, err: String(e).slice(0, 120) });
    if (fails > 5) { out.skipped = "partial-abort"; break; }
  }
  await new Promise((s) => setTimeout(s, 120));
}
fs.writeFileSync("/tmp/authority/bing_page_query.json", JSON.stringify(out));
console.log("fanout done; pages ok:", Object.keys(out.pages).length, "failures:", out.failures.length, "skipped:", out.skipped);
