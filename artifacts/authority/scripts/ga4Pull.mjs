import fs from "node:fs";
import crypto from "node:crypto";
const sa = JSON.parse(process.env.GA4_SERVICE_ACCOUNT_JSON);
const propertyId = (process.env.GA4_PROPERTY_ID || "").replace(/^properties\//, "").trim();
const b64url = (b) => Buffer.from(b).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const hdr = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
const claim = b64url(JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/analytics.readonly", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
const sig = crypto.createSign("RSA-SHA256").update(hdr + "." + claim).sign(sa.private_key);
const tr = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: hdr + "." + claim + "." + b64url(sig) }),
});
const tok = (await tr.json()).access_token;
if (!tok) throw new Error("GA4 token failed");
async function report(body) {
  const r = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`, {
    method: "POST", headers: { authorization: "Bearer " + tok, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return r.json();
}
const dateRanges = [{ startDate: "2026-01-27", endDate: "2026-07-26" }];
const organicFilter = { filter: { fieldName: "sessionDefaultChannelGroup", stringFilter: { matchType: "EXACT", value: "Organic Search" } } };
const out = { pulledAt: new Date().toISOString() };
out.engagement = await report({
  dateRanges,
  dimensions: [{ name: "hostName" }, { name: "landingPage" }, { name: "sessionSource" }],
  metrics: [{ name: "sessions" }, { name: "engagedSessions" }, { name: "userEngagementDuration" }],
  dimensionFilter: organicFilter,
  limit: 100000,
});
console.log("engagement rows:", out.engagement.rows?.length ?? 0, out.engagement.error ? JSON.stringify(out.engagement.error).slice(0, 200) : "");
out.keyEvents = await report({
  dateRanges,
  dimensions: [{ name: "landingPage" }, { name: "sessionSource" }],
  metrics: [{ name: "keyEvents:signup_success" }, { name: "keyEvents:invitee_meeting_scheduled" }],
  dimensionFilter: organicFilter,
  limit: 100000,
});
console.log("keyEvents rows:", out.keyEvents.rows?.length ?? 0, out.keyEvents.error ? JSON.stringify(out.keyEvents.error).slice(0, 200) : "");
fs.writeFileSync("/tmp/authority/ga4.json", JSON.stringify(out));
console.log("WROTE /tmp/authority/ga4.json");
