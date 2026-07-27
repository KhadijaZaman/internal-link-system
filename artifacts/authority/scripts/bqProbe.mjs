import crypto from "node:crypto";
const b64url = (buf) => Buffer.from(buf).toString("base64url");
async function token(sa, scope) {
  const now = Math.floor(Date.now() / 1000);
  const hdr = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({ iss: sa.client_email, scope, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const sig = crypto.createSign("RSA-SHA256").update(hdr + "." + claim).sign(sa.private_key);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: hdr + "." + claim + "." + b64url(sig) }),
  });
  const j = await res.json();
  if (!j.access_token) throw new Error("token fail: " + JSON.stringify(j));
  return j.access_token;
}
for (const k of ["GA4_SERVICE_ACCOUNT_JSON", "GA4_PROPERTY_ID", "GSC_REFRESH_TOKEN", "BING_WEBMASTER_API_KEY", "DATABASE_URL"])
  console.log("env", k + ":", process.env[k] ? "present" : "MISSING");
const raw = process.env.GA4_SERVICE_ACCOUNT_JSON;
if (!raw) process.exit(0);
const sa = JSON.parse(raw);
console.log("SA:", sa.client_email, "| home project:", sa.project_id);
const tok = await token(sa, "https://www.googleapis.com/auth/bigquery.readonly");
const ph = await fetch("https://bigquery.googleapis.com/bigquery/v2/projects?maxResults=100", { headers: { authorization: "Bearer " + tok } });
const pj = await ph.json();
const projects = (pj.projects || []).map((p) => p.id);
console.log("BQ projects visible:", JSON.stringify(projects), pj.error ? "err:" + JSON.stringify(pj.error) : "");
for (const pid of projects.length ? projects : [sa.project_id]) {
  const dh = await fetch(`https://bigquery.googleapis.com/bigquery/v2/projects/${pid}/datasets?all=true`, { headers: { authorization: "Bearer " + tok } });
  const dj = await dh.json();
  const ds = (dj.datasets || []).map((d) => d.datasetReference.datasetId);
  console.log(`datasets in ${pid}:`, JSON.stringify(ds), dj.error ? "err:" + JSON.stringify(dj.error) : "");
  for (const d of ds.filter((x) => /searchconsole|search_console|gsc/i.test(x))) {
    const th = await fetch(`https://bigquery.googleapis.com/bigquery/v2/projects/${pid}/datasets/${d}/tables`, { headers: { authorization: "Bearer " + tok } });
    const tj = await th.json();
    console.log(`tables in ${pid}.${d}:`, JSON.stringify((tj.tables || []).map((t) => t.tableReference.tableId)));
  }
}
