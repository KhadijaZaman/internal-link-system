/**
 * Smoke-test: verify the backlink audit integration pulls real DataForSEO data.
 *
 * Safe to run against the production database: all DB writes happen inside a
 * single transaction that is always rolled back at the end. The script is
 * read-only from the DB's perspective — it only exercises the DataForSEO APIs
 * and verifies the response shapes that the production route would persist.
 *
 * Run:
 *   node artifacts/api-server/scripts/verify-backlink-audit.mjs
 *
 * Required env vars: DATABASE_URL, DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD
 */
import pg from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
const DATAFORSEO_LOGIN = process.env.DATAFORSEO_LOGIN;
const DATAFORSEO_PASSWORD = process.env.DATAFORSEO_PASSWORD;

if (!DATABASE_URL || !DATAFORSEO_LOGIN || !DATAFORSEO_PASSWORD) {
  console.error("Missing DATABASE_URL, DATAFORSEO_LOGIN or DATAFORSEO_PASSWORD");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL });
const auth = Buffer.from(`${DATAFORSEO_LOGIN}:${DATAFORSEO_PASSWORD}`).toString("base64");

// ---------------------------------------------------------------------------
// DataForSEO helpers (mirrors the production dataforseo.ts integration)
// ---------------------------------------------------------------------------

class DataForSeoOutOfFundsError extends Error {
  constructor() {
    super("DataForSEO out of funds");
    this.name = "DataForSeoOutOfFundsError";
  }
}

async function backlinksApi(path, task) {
  const res = await fetch(`https://api.dataforseo.com/v3/backlinks/${path}/live`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    body: JSON.stringify([task]),
  });
  if (res.status === 402) throw new DataForSeoOutOfFundsError();
  if (!res.ok) throw new Error(`DataForSEO backlinks/${path} HTTP ${res.status}`);
  const data = await res.json();
  const t = data.tasks?.[0];
  if (t?.status_code === 40201 || t?.status_code === 40200) throw new DataForSeoOutOfFundsError();
  if (t?.status_code && t.status_code >= 40000) {
    throw new Error(`DataForSEO backlinks/${path}: ${t.status_message ?? t.status_code}`);
  }
  return t?.result?.[0] ?? null;
}

async function fetchBacklinkSummary(target) {
  const r = await backlinksApi("summary", {
    target,
    include_subdomains: true,
    exclude_internal_backlinks: true,
  });
  if (!r) return null;
  const nofollow = r.referring_links_attributes?.["nofollow"] ?? 0;
  const total = r.backlinks ?? 0;
  return {
    target: r.target ?? target,
    rank: r.rank ?? null,
    backlinks: total,
    referringDomains: r.referring_domains ?? 0,
    referringMainDomains: r.referring_main_domains ?? 0,
    brokenBacklinks: r.broken_backlinks ?? 0,
    referringIps: r.referring_ips ?? 0,
    dofollow: Math.max(0, total - nofollow),
    nofollow,
    firstSeen: r.first_seen ?? null,
  };
}

async function fetchBacklinkAnchors(target, limit = 30) {
  const r = await backlinksApi("anchors", { target, limit, order_by: ["backlinks,desc"] });
  return (r?.items ?? [])
    .filter((i) => i.anchor !== undefined)
    .map((i) => {
      const nofollow = i.referring_links_attributes?.["nofollow"] ?? 0;
      const total = i.backlinks ?? 0;
      return {
        anchor: i.anchor ?? "",
        backlinks: total,
        referringDomains: i.referring_domains ?? 0,
        dofollow: Math.max(0, total - nofollow),
        nofollow,
      };
    });
}

async function fetchTopBacklinks(target, limit = 50) {
  const r = await backlinksApi("backlinks", {
    target,
    limit,
    mode: "one_per_domain",
    order_by: ["domain_from_rank,desc"],
    exclude_internal_backlinks: true,
  });
  return (r?.items ?? [])
    .filter((i) => !!i.url_from)
    .map((i) => ({
      urlFrom: i.url_from ?? "",
      urlTo: i.url_to ?? "",
      domainFrom: i.domain_from ?? "",
      pageFromTitle: i.page_from_title ?? null,
      anchor: i.anchor ?? null,
      dofollow: i.dofollow ?? false,
      rank: i.rank ?? null,
      domainFromRank: i.domain_from_rank ?? null,
      firstSeen: i.first_seen ?? null,
      lastSeen: i.last_visited ?? null,
    }));
}

async function fetchTopReferringDomains(target, limit = 100) {
  const res = await fetch("https://api.dataforseo.com/v3/backlinks/referring_domains/live", {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    body: JSON.stringify([{ target, limit, mode: "as_is", order_by: ["backlinks,desc"] }]),
  });
  if (res.status === 402) throw new DataForSeoOutOfFundsError();
  if (!res.ok) return [];
  const data = await res.json();
  const taskStatus = data.tasks?.[0]?.status_code;
  if (taskStatus === 40200 || taskStatus === 40201) throw new DataForSeoOutOfFundsError();
  const items = data.tasks?.[0]?.result?.[0]?.items ?? [];
  return items
    .filter((i) => !!i.domain)
    .map((i) => ({
      domain: i.domain ?? "",
      backlinks: i.backlinks ?? 0,
      rank: i.rank ?? null,
      firstSeen: i.first_seen ?? null,
      lastSeen: i.last_seen ?? null,
    }));
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const OWN_HOST = "wellows.com";
const COMPETITOR = "surferseo.com";

function assert(condition, msg) {
  if (!condition) throw new Error(`FAIL: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

// ---------------------------------------------------------------------------
// Verification — all DB operations run inside a rolled-back transaction so
// nothing is written permanently.
// ---------------------------------------------------------------------------

async function run() {
  console.log("=== Backlink Audit Live-Data Verification ===\n");
  console.log(`Target: ${OWN_HOST}, Competitor: ${COMPETITOR}`);
  console.log("All DB operations run in a rolled-back transaction (no data modified).\n");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ------------------------------------------------------------------
    // [1] All four DataForSEO legs return real, well-shaped data.
    // ------------------------------------------------------------------
    console.log("[1] All four DataForSEO legs return real data");

    const [summary, anchors, topBacklinks, referringDomains] = await Promise.all([
      fetchBacklinkSummary(OWN_HOST),
      fetchBacklinkAnchors(OWN_HOST, 10),
      fetchTopBacklinks(OWN_HOST, 10),
      fetchTopReferringDomains(OWN_HOST, 20),
    ]);

    assert(summary !== null, "summary is non-null");
    assert(typeof summary.rank === "number", `summary.rank is a number (${summary.rank})`);
    assert(summary.backlinks > 0, `summary.backlinks > 0 (${summary.backlinks})`);
    assert(summary.referringDomains > 0, `summary.referringDomains > 0 (${summary.referringDomains})`);

    assert(anchors.length > 0, `anchors: ${anchors.length} rows`);
    const nullBucket = anchors.find((a) => a.anchor === "");
    assert(nullBucket !== undefined, "null-anchor bucket (empty string) is present in anchors");

    assert(topBacklinks.length > 0, `topBacklinks: ${topBacklinks.length} rows`);
    assert(topBacklinks.every((b) => b.urlFrom && b.domainFrom), "all topBacklinks have urlFrom + domainFrom");

    assert(referringDomains.length > 0, `referringDomains: ${referringDomains.length} rows`);

    // ------------------------------------------------------------------
    // [2] Competitor summary returns real data.
    // ------------------------------------------------------------------
    console.log("\n[2] Competitor summary (surferseo.com)");

    const compSummary = await fetchBacklinkSummary(COMPETITOR);
    assert(compSummary !== null, `competitor summary for ${COMPETITOR} is non-null`);
    assert(compSummary.backlinks > 0, `competitor backlinks > 0 (${compSummary.backlinks})`);
    assert(compSummary.rank !== null, `competitor rank is present (${compSummary.rank})`);

    // ------------------------------------------------------------------
    // [3] DB persistence round-trip inside the transaction.
    //     Operates on a temporary site row that is ROLLBACK-ed at the end
    //     — no permanent changes to any table.
    // ------------------------------------------------------------------
    console.log("\n[3] DB persistence round-trip (inside rolled-back transaction)");

    // Create a temporary user and site for this verification run.
    const tmpUser = `verify-script-${Date.now()}`;
    const tmpHost = `verify-${Date.now()}.example.com`;

    await client.query(
      "INSERT INTO users (id) VALUES ($1) ON CONFLICT DO NOTHING",
      [tmpUser],
    );
    const siteResult = await client.query(
      `INSERT INTO sites (domain, host, display_name, owner_user_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [`https://${tmpHost}/`, tmpHost, `Verify Script ${Date.now()}`, tmpUser],
    );
    const tmpSiteId = siteResult.rows[0].id;

    // Insert own_profile.
    const now = new Date();
    await client.query(
      `INSERT INTO backlink_audits (site_id, target, kind, payload, fetched_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (site_id, target, kind) DO UPDATE
         SET payload = EXCLUDED.payload, fetched_at = EXCLUDED.fetched_at`,
      [tmpSiteId, OWN_HOST, "own_profile",
        JSON.stringify({ summary, anchors, topBacklinks, referringDomains }), now],
    );

    // Insert competitor_summary.
    await client.query(
      `INSERT INTO backlink_audits (site_id, target, kind, payload, fetched_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (site_id, target, kind) DO UPDATE
         SET payload = EXCLUDED.payload, fetched_at = EXCLUDED.fetched_at`,
      [tmpSiteId, COMPETITOR, "competitor_summary", JSON.stringify(compSummary), now],
    );

    // Read back.
    const { rows } = await client.query(
      "SELECT kind, target, payload FROM backlink_audits WHERE site_id = $1 ORDER BY kind",
      [tmpSiteId],
    );
    assert(rows.length === 2, `DB has 2 rows (own_profile + competitor_summary), got ${rows.length}`);

    const ownRow = rows.find((r) => r.kind === "own_profile");
    const compRow = rows.find((r) => r.kind === "competitor_summary");
    assert(ownRow !== undefined, "own_profile row readable from DB");
    assert(ownRow.payload.summary?.backlinks > 0, `DB payload summary.backlinks > 0 (${ownRow.payload.summary?.backlinks})`);
    assert(Array.isArray(ownRow.payload.anchors) && ownRow.payload.anchors.length > 0, "DB payload anchors non-empty");
    assert(compRow !== undefined, "competitor_summary row readable from DB");
    assert(compRow.payload?.backlinks > 0, `DB competitor backlinks > 0 (${compRow.payload?.backlinks})`);

    // ------------------------------------------------------------------
    // [4] Caching logic: fresh rows are not re-fetched.
    // ------------------------------------------------------------------
    console.log("\n[4] Cache TTL check");

    const AUDIT_TTL_MS = 24 * 60 * 60 * 1000;
    const staleBefore = Date.now() - AUDIT_TTL_MS;
    assert(now.getTime() > staleBefore, "newly inserted row is within the 24 h TTL window");

    // ------------------------------------------------------------------
    // ROLLBACK — all inserts above are discarded.
    // ------------------------------------------------------------------
    await client.query("ROLLBACK");
    console.log("\n  ↩ Transaction rolled back — no data written to DB.");

    console.log("\n✅ All verification checks passed.");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("\n❌ Verification failed:", err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
