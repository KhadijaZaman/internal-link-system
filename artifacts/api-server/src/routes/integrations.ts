import { Router, type IRouter } from "express";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { google } from "googleapis";
import { db, siteIntegrationsTable, sitesTable, trackedSubmissionsTable } from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";
import {
  ConnectBingBody,
  ConnectGa4Body,
  ConnectWpBody,
  PublishToCmsBody,
  SetGscPropertyBody,
} from "@workspace/api-zod";
import { marked } from "marked";
import {
  verifyWpCreds,
  publishPost,
  WpApiError,
  WpUrlBlockedError,
} from "../integrations/wordpressPublish";
import { requireAuth } from "../lib/auth";
import { requireSite, getSite } from "../lib/site";
import {
  gscOauthApp,
  integrationStatus,
  invalidateIntegrationCache,
  getIntegrationRow,
  IntegrationNotConnectedError,
  type IntegrationProvider,
} from "../lib/siteIntegrations";
import { refreshExactImpressions } from "../services/keywordMovementSheet";

const router: IRouter = Router();

/**
 * Fire-and-forget: when GSC becomes usable for a site (connect/reconnect with
 * a matched property, or the owner picks a property), immediately measure any
 * tracked rows still showing "Keyword not checked yet"
 * (exactImpressionsCheckedAt is null) so the badge clears within minutes
 * instead of waiting for the next daily sync. Failures are logged and
 * swallowed — the daily job self-heals.
 */
function refreshUnmeasuredKeywordsInBackground(
  log: { info: (obj: unknown, msg: string) => void; error: (obj: unknown, msg: string) => void },
  siteId: number,
): void {
  void (async () => {
    const rows = await db
      .select({
        id: trackedSubmissionsTable.id,
        url: trackedSubmissionsTable.url,
        keyword: trackedSubmissionsTable.keyword,
      })
      .from(trackedSubmissionsTable)
      .where(
        and(
          eq(trackedSubmissionsTable.siteId, siteId),
          isNull(trackedSubmissionsTable.exactImpressionsCheckedAt),
        ),
      );
    const withKeyword = rows.filter((r) => (r.keyword ?? "").trim().length > 0);
    if (withKeyword.length === 0) return;
    const count = await refreshExactImpressions(siteId, withKeyword);
    log.info({ siteId, count }, "refreshed exact-impressions after GSC connect");
  })().catch((err: unknown) => {
    if (err instanceof IntegrationNotConnectedError) {
      log.info({ siteId }, "post-connect exact-impressions refresh skipped — GSC not usable yet");
      return;
    }
    log.error({ err, siteId }, "post-connect exact-impressions refresh failed");
  });
}

// ---------------------------------------------------------------------------
// Per-site data-source connections.
//
// GSC uses the shared Google OAuth app (GSC_CLIENT_ID/SECRET): the operator
// clicks Connect, grants read-only Search Console access with their own
// Google account, and we store the per-site refresh token. The callback is
// hit by Google's redirect (no Clerk session headers), so it is protected by
// a short-lived HMAC-signed state token binding {siteId, userId} instead.
//
// GA4 (service-account JSON + property id) and Bing (API key) are pasted
// credentials, verified with a live read before being stored.
//
// Credentials are NEVER returned by any endpoint here — only status/config.
// ---------------------------------------------------------------------------

const GSC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const STATE_TTL_MS = 15 * 60 * 1000;

function stateSecret(): string {
  const s = process.env["SESSION_SECRET"] || process.env["CLERK_SECRET_KEY"];
  if (!s) throw new Error("SESSION_SECRET or CLERK_SECRET_KEY must be set for OAuth state signing");
  return s;
}

// ---------------------------------------------------------------------------
// Per-site current-flow nonce store
//
// Only ONE OAuth flow is live per site at a time.  When the owner clicks
// "Connect GSC" (POST /integrations/gsc/auth-url) a fresh nonce is generated
// and recorded here as the site's "active" nonce.  Any previous active nonce
// is silently superseded — the older in-flight callback will be rejected when
// it arrives because its nonce no longer matches.
//
// The callback first does a fast in-memory verifyFlowNonce check, then after
// the async Google token exchange it performs an atomic conditional DB UPDATE
// WHERE flow_nonce = $nonce.  A disconnect (DELETE) removes the row including
// flow_nonce, so any stale in-flight callback finds 0 matching rows and is
// rejected without writing credentials.
//
// The Map is keyed siteId → { nonce, exp }.  No background cleanup is
// required: entries are either consumed by the callback or expire naturally
// after STATE_TTL_MS (15 min); expired entries are pruned lazily.
// ---------------------------------------------------------------------------
const activeFlowNonce = new Map<number, { nonce: string; exp: number }>();

/**
 * Register a new active-flow nonce for a site, superseding any previous one.
 */
function registerFlowNonce(siteId: number, nonce: string, exp: number): void {
  activeFlowNonce.set(siteId, { nonce, exp });
}

/**
 * Fast in-process nonce check at the top of the callback.
 *
 * The in-memory map is a performance optimisation — an optional fast-reject
 * path for callbacks whose nonce is definitively wrong within the current
 * process (e.g. two rapid reconnects on the same instance).  It is NOT
 * authoritative: on a map miss (empty after a restart, or the callback was
 * routed to a different instance) we return true and let the DB conditional
 * write decide.  Only a positive MISMATCH (we have an entry but it doesn't
 * match) is grounds for an early rejection here.
 *
 * The authoritative check is the UPDATE … WHERE flow_nonce = $nonce at the
 * end of the callback, which closes the race at the DB level regardless of
 * in-process state.
 */
function verifyFlowNonce(siteId: number, nonce: string): boolean {
  const entry = activeFlowNonce.get(siteId);
  if (!entry) return true; // map miss — let the DB conditional write decide
  return entry.nonce === nonce && entry.exp >= Date.now();
}

/**
 * Remove the in-memory nonce entry for a site ONLY when it still matches the
 * presented nonce.  Called after a successful conditional DB write so that a
 * replayed callback sees no entry in the fast early-rejection path.
 *
 * A mismatch (the entry was already superseded by a new auth-url) is a no-op:
 * the new nonce must remain in the map for the legitimate new-flow callback.
 */
function consumeFlowNonce(siteId: number, nonce: string): void {
  const entry = activeFlowNonce.get(siteId);
  if (entry && entry.nonce === nonce) {
    activeFlowNonce.delete(siteId);
  }
}

/**
 * Invalidate any pending GSC OAuth flow for a site (called on disconnect).
 */
function invalidateFlowNonce(siteId: number): void {
  activeFlowNonce.delete(siteId);
}

function signState(payload: { siteId: number; userId: string; exp: number }): {
  state: string;
  nonce: string;
} {
  const nonce = randomBytes(16).toString("hex");
  const body = Buffer.from(JSON.stringify({ ...payload, nonce })).toString("base64url");
  const sig = createHmac("sha256", stateSecret()).update(body).digest("base64url");
  return { state: `${body}.${sig}`, nonce };
}

function verifyState(state: string): { siteId: number; userId: string; nonce: string; exp: number } | null {
  const parts = state.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = createHmac("sha256", stateSecret()).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as {
      siteId?: number;
      userId?: string;
      exp?: number;
      nonce?: string;
    };
    if (
      typeof payload.siteId !== "number" ||
      typeof payload.userId !== "string" ||
      typeof payload.exp !== "number" ||
      typeof payload.nonce !== "string" ||
      !payload.nonce ||
      payload.exp < Date.now()
    ) {
      return null;
    }
    return { siteId: payload.siteId, userId: payload.userId, nonce: payload.nonce, exp: payload.exp };
  } catch {
    return null;
  }
}

/** Public https origin of this app (Google needs an exact registered redirect URI). */
function appOrigin(): string {
  const prod = (process.env["REPLIT_DOMAINS"] ?? "").split(",")[0]?.trim();
  const dev = process.env["REPLIT_DEV_DOMAIN"]?.trim();
  const host = process.env["NODE_ENV"] === "production" ? prod || dev : dev || prod;
  if (!host) throw new Error("REPLIT_DOMAINS / REPLIT_DEV_DOMAIN not set");
  return `https://${host}`;
}

function gscRedirectUri(): string {
  return `${appOrigin()}/api/integrations/gsc/callback`;
}

async function upsertIntegration(
  siteId: number,
  provider: IntegrationProvider,
  credentials: Record<string, unknown>,
  config: Record<string, unknown>,
): Promise<void> {
  await db
    .insert(siteIntegrationsTable)
    .values({ siteId, provider, credentials, config, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [siteIntegrationsTable.siteId, siteIntegrationsTable.provider],
      set: { credentials, config, updatedAt: new Date() },
    });
  invalidateIntegrationCache(siteId, provider);
}

/** Pick the GSC property that matches the site's host, if any. */
function matchProperty(properties: string[], host: string): string | null {
  const bare = host.replace(/^www\./, "").toLowerCase();
  for (const p of properties) {
    if (p.toLowerCase() === `sc-domain:${bare}`) return p;
  }
  for (const p of properties) {
    try {
      const h = new URL(p).hostname.replace(/^www\./, "").toLowerCase();
      if (h === bare) return p;
    } catch {
      // not a URL-prefix property
    }
  }
  return null;
}

// ---- Status ----------------------------------------------------------------

router.get("/integrations", requireAuth, requireSite, async (req, res, next) => {
  try {
    const site = getSite(req);
    const status = await integrationStatus(site.id);
    res.json(status);
  } catch (err) {
    next(err);
  }
});

// ---- GSC OAuth --------------------------------------------------------------

router.post("/integrations/gsc/auth-url", requireAuth, requireSite, async (req, res, next) => {
  try {
    const site = getSite(req);
    const app = gscOauthApp();
    const redirectUri = gscRedirectUri();
    const oauth = new google.auth.OAuth2(app.clientId, app.clientSecret, redirectUri);
    const exp = Date.now() + STATE_TTL_MS;
    const { state, nonce } = signState({
      siteId: site.id,
      userId: site.ownerUserId!,
      exp,
    });
    // Register this nonce as the only valid active flow for this site.
    // Any previously pending flow (e.g. from before a disconnect) is superseded.
    registerFlowNonce(site.id, nonce, exp);
    // Also persist the nonce to the DB.  The callback's credential write is a
    // conditional UPDATE WHERE flow_nonce = $nonce, so the "flow still active"
    // check and the credential write are atomic at the DB level.  A disconnect
    // (DELETE) removes the nonce along with the row, so any stale in-flight
    // callback that races past the in-memory check will find 0 matching rows.
    await db
      .insert(siteIntegrationsTable)
      .values({
        siteId: site.id,
        provider: "gsc",
        credentials: {},
        config: { property: null, availableProperties: [] },
        flowNonce: nonce,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [siteIntegrationsTable.siteId, siteIntegrationsTable.provider],
        set: { flowNonce: nonce, updatedAt: new Date() },
      });
    const url = oauth.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: [GSC_SCOPE],
      state,
    });
    res.json({ url, redirectUri });
  } catch (err) {
    next(err);
  }
});

// Google redirects here — no Clerk session headers, gated by the signed state.
router.get("/integrations/gsc/callback", async (req, res, next) => {
  const dashboardUrl = `${appOrigin()}/settings`;
  try {
    const code = typeof req.query["code"] === "string" ? req.query["code"] : "";
    const state = typeof req.query["state"] === "string" ? req.query["state"] : "";
    if (typeof req.query["error"] === "string") {
      res.redirect(`${dashboardUrl}?gsc=denied`);
      return;
    }
    const verified = state ? verifyState(state) : null;
    if (!code || !verified) {
      res.redirect(`${dashboardUrl}?gsc=invalid`);
      return;
    }

    // Early nonce check (non-destructive): reject callbacks whose nonce is
    // already wrong before starting any async work.  Does NOT consume the
    // entry so a concurrent new-flow callback carrying the correct nonce can
    // still succeed.
    if (!verifyFlowNonce(verified.siteId, verified.nonce)) {
      req.log.warn(
        { siteId: verified.siteId },
        "GSC OAuth: flow nonce invalid or superseded — callback rejected",
      );
      res.redirect(`${dashboardUrl}?gsc=invalid`);
      return;
    }

    // Re-check ownership: the state's user must still own the site.
    const rows = await db
      .select({ ownerUserId: sitesTable.ownerUserId, host: sitesTable.host })
      .from(sitesTable)
      .where(eq(sitesTable.id, verified.siteId))
      .limit(1);
    if (rows.length === 0 || rows[0].ownerUserId !== verified.userId) {
      res.redirect(`${dashboardUrl}?gsc=invalid`);
      return;
    }

    const app = gscOauthApp();
    const oauth = new google.auth.OAuth2(app.clientId, app.clientSecret, gscRedirectUri());
    const { tokens } = await oauth.getToken(code);
    const refreshToken = tokens.refresh_token;
    if (!refreshToken) {
      req.log.warn({ siteId: verified.siteId }, "GSC OAuth: no refresh token returned");
      res.redirect(`${dashboardUrl}?gsc=error`);
      return;
    }

    // List the Google account's GSC properties and auto-match the site host.
    oauth.setCredentials(tokens);
    const sc = google.searchconsole({ version: "v1", auth: oauth });
    let properties: string[] = [];
    try {
      const list = await sc.sites.list();
      properties = (list.data.siteEntry ?? [])
        .filter((e) => e.permissionLevel !== "siteUnverifiedUser")
        .map((e) => e.siteUrl ?? "")
        .filter(Boolean);
    } catch (err) {
      req.log.warn({ err, siteId: verified.siteId }, "GSC OAuth: sites.list failed");
    }
    const property = matchProperty(properties, rows[0].host);

    // Atomic credential write: UPDATE WHERE flow_nonce = $nonce.
    //
    // This is the race-proof replacement for a separate nonce check + upsert.
    // A disconnect (DELETE) removes the row — including flow_nonce — so a
    // stale in-flight callback that raced past the early verifyFlowNonce check
    // finds 0 matching rows here and is rejected without writing anything.
    // A new auth-url (reconnect) overwrites flow_nonce with a new value, so
    // this UPDATE's WHERE clause also fails for the old callback.
    //
    // The returning() call confirms how many rows were updated; 0 rows means
    // the flow was superseded or the site was disconnected during the async
    // token-exchange / property-discovery above.
    const written = await db
      .update(siteIntegrationsTable)
      .set({
        credentials: { refreshToken },
        config: { property, availableProperties: properties.slice(0, 100) },
        flowNonce: null, // consume: clear after a successful write
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(siteIntegrationsTable.siteId, verified.siteId),
          eq(siteIntegrationsTable.provider, "gsc"),
          eq(siteIntegrationsTable.flowNonce, verified.nonce),
        ),
      )
      .returning({ id: siteIntegrationsTable.id });

    if (written.length === 0) {
      req.log.warn(
        { siteId: verified.siteId },
        "GSC OAuth: flow superseded or disconnected during token exchange — conditional write found 0 rows",
      );
      res.redirect(`${dashboardUrl}?gsc=invalid`);
      return;
    }
    // Sync the in-memory nonce store: remove this nonce so a replayed callback
    // fails the fast early-rejection check instead of reaching the DB.
    // consumeFlowNonce is a no-op when a new flow already registered a
    // different nonce (e.g. a reconnect happened between verifyFlowNonce and
    // the DB write above — the DB correctly rejected it via flow_nonce mismatch
    // so the new nonce must stay in the map for the new-flow callback).
    consumeFlowNonce(verified.siteId, verified.nonce);
    invalidateIntegrationCache(verified.siteId, "gsc");
    req.log.info(
      { siteId: verified.siteId, property, propertyCount: properties.length },
      "GSC connected",
    );
    // A matched property means GSC is immediately usable — measure any
    // tracked keywords that were waiting for it. (No property yet → the
    // property-pick route below triggers the same refresh.)
    if (property) {
      refreshUnmeasuredKeywordsInBackground(req.log, verified.siteId);
    }
    res.redirect(`${dashboardUrl}?gsc=${property ? "connected" : "pick-property"}`);
  } catch (err) {
    req.log.error({ err }, "GSC OAuth callback failed");
    try {
      res.redirect(`${dashboardUrl}?gsc=error`);
    } catch {
      next(err);
    }
  }
});

router.get("/integrations/gsc/properties", requireAuth, requireSite, async (req, res, next) => {
  try {
    const site = getSite(req);
    const row = await getIntegrationRow(site.id, "gsc");
    if (!row || typeof row.credentials["refreshToken"] !== "string") {
      res.status(409).json({ error: "GSC is not connected for this site" });
      return;
    }
    const properties = Array.isArray(row.config["availableProperties"])
      ? (row.config["availableProperties"] as string[]).filter((p) => typeof p === "string")
      : [];
    res.json({
      properties,
      selected: typeof row.config["property"] === "string" ? (row.config["property"] as string) : null,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/integrations/gsc/property", requireAuth, requireSite, async (req, res, next) => {
  try {
    const site = getSite(req);
    const parsed = SetGscPropertyBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }
    const row = await getIntegrationRow(site.id, "gsc");
    if (!row || typeof row.credentials["refreshToken"] !== "string") {
      res.status(409).json({ error: "GSC is not connected for this site" });
      return;
    }
    const available = Array.isArray(row.config["availableProperties"])
      ? (row.config["availableProperties"] as string[])
      : [];
    if (!available.includes(parsed.data.property)) {
      res.status(400).json({ error: "Property is not in the connected account's list" });
      return;
    }
    await upsertIntegration(site.id, "gsc", row.credentials, {
      ...row.config,
      property: parsed.data.property,
    });
    // Picking a property is the moment GSC becomes queryable for sites whose
    // host didn't auto-match — clear any waiting "not checked yet" keywords.
    refreshUnmeasuredKeywordsInBackground(req.log, site.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---- GA4 (pasted service account) -------------------------------------------

router.put("/integrations/ga4", requireAuth, requireSite, async (req, res, next) => {
  try {
    const site = getSite(req);
    const parsed = ConnectGa4Body.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }
    let sa: { client_email?: string; private_key?: string };
    try {
      sa = JSON.parse(parsed.data.serviceAccountJson) as typeof sa;
    } catch {
      res.status(400).json({ error: "Service account JSON is not valid JSON" });
      return;
    }
    if (!sa.client_email || !sa.private_key) {
      res.status(400).json({ error: "Service account JSON must include client_email and private_key" });
      return;
    }
    const propertyId = parsed.data.propertyId.replace(/^properties\//, "").trim();
    if (!/^\d+$/.test(propertyId)) {
      res.status(400).json({ error: "Property ID must be numeric (e.g. 123456789)" });
      return;
    }

    // Verify with a live call before storing.
    try {
      const auth = new google.auth.JWT({
        email: sa.client_email,
        key: sa.private_key,
        scopes: ["https://www.googleapis.com/auth/analytics.readonly"],
      });
      const { token } = await auth.getAccessToken();
      if (!token) throw new Error("no token");
      const check = await fetch(
        `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}/metadata`,
        { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) },
      );
      if (!check.ok) {
        res.status(400).json({
          error: `GA4 check failed (HTTP ${check.status}) — make sure the service account has Viewer access to property ${propertyId}`,
        });
        return;
      }
    } catch (err) {
      req.log.warn({ err, siteId: site.id }, "GA4 credential verification failed");
      res.status(400).json({ error: "Could not authenticate with these credentials" });
      return;
    }

    await upsertIntegration(
      site.id,
      "ga4",
      { clientEmail: sa.client_email, privateKey: sa.private_key },
      { propertyId },
    );
    req.log.info({ siteId: site.id, propertyId }, "GA4 connected");
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---- Bing (pasted API key) ---------------------------------------------------

router.put("/integrations/bing", requireAuth, requireSite, async (req, res, next) => {
  try {
    const site = getSite(req);
    const parsed = ConnectBingBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }
    const apiKey = parsed.data.apiKey.trim();

    // Verify the key with a cheap read.
    try {
      const check = await fetch(
        `https://ssl.bing.com/webmaster/api.svc/json/GetUserSites?apikey=${encodeURIComponent(apiKey)}`,
        { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) },
      );
      if (!check.ok) {
        res.status(400).json({ error: `Bing rejected the API key (HTTP ${check.status})` });
        return;
      }
    } catch (err) {
      req.log.warn({ err, siteId: site.id }, "Bing key verification failed");
      res.status(400).json({ error: "Could not verify the Bing API key" });
      return;
    }

    await upsertIntegration(site.id, "bing", { apiKey }, {});
    req.log.info({ siteId: site.id }, "Bing connected");
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---- WordPress (Application Password, used for publishing) -------------------

router.put("/integrations/wp", requireAuth, requireSite, async (req, res, next) => {
  try {
    const site = getSite(req);
    const parsed = ConnectWpBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }
    let baseUrl = parsed.data.baseUrl.trim().replace(/\/$/, "");
    if (!/^https?:\/\//.test(baseUrl)) baseUrl = `https://${baseUrl}`;
    try {
      new URL(baseUrl);
    } catch {
      res.status(400).json({ error: "Invalid site URL" });
      return;
    }
    const username = parsed.data.username.trim();
    const appPassword = parsed.data.appPassword.trim();

    try {
      const name = await verifyWpCreds({ baseUrl, username, appPassword });
      req.log.info({ siteId: site.id, name }, "WordPress credentials verified");
    } catch (err) {
      req.log.warn({ err, siteId: site.id }, "WordPress verification failed");
      const msg =
        err instanceof WpApiError || err instanceof WpUrlBlockedError
          ? err.message
          : "Could not reach the WordPress REST API — check the URL and Application Password";
      res.status(400).json({ error: msg });
      return;
    }

    await upsertIntegration(site.id, "wp", { username, appPassword }, { baseUrl });
    req.log.info({ siteId: site.id }, "WordPress connected");
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post("/cms/publish", requireAuth, requireSite, async (req, res, next) => {
  try {
    const site = getSite(req);
    const parsed = PublishToCmsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }
    const { title, markdown, status, slug, excerpt } = parsed.data;
    const contentHtml = await marked.parse(markdown, { async: true });
    try {
      const result = await publishPost(site.id, {
        title,
        contentHtml,
        status,
        slug: slug ?? null,
        excerpt: excerpt ?? null,
      });
      req.log.info(
        { siteId: site.id, postId: result.postId, status: result.status },
        "Published to WordPress",
      );
      res.json(result);
    } catch (err) {
      if (err instanceof IntegrationNotConnectedError) {
        res.status(400).json({ error: "WordPress is not connected — add it in Settings → Connections" });
        return;
      }
      if (err instanceof WpApiError || err instanceof WpUrlBlockedError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

// ---- Disconnect ---------------------------------------------------------------

router.delete("/integrations/:provider", requireAuth, requireSite, async (req, res, next) => {
  try {
    const site = getSite(req);
    const provider = req.params["provider"];
    if (provider !== "gsc" && provider !== "ga4" && provider !== "bing" && provider !== "wp") {
      res.status(400).json({ error: "Unknown provider" });
      return;
    }
    await db
      .delete(siteIntegrationsTable)
      .where(
        and(
          eq(siteIntegrationsTable.siteId, site.id),
          eq(siteIntegrationsTable.provider, provider),
        ),
      );
    invalidateIntegrationCache(site.id, provider);
    // Invalidate any pending GSC OAuth flow so a stale in-flight callback
    // that arrives after the disconnect cannot attach the old Google account.
    if (provider === "gsc") {
      invalidateFlowNonce(site.id);
    }
    req.log.info({ siteId: site.id, provider }, "integration disconnected");
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
