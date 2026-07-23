import { Router, type IRouter } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { google } from "googleapis";
import { db, siteIntegrationsTable, sitesTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { ConnectBingBody, ConnectGa4Body, SetGscPropertyBody } from "@workspace/api-zod";
import { requireAuth } from "../lib/auth";
import { requireSite, getSite } from "../lib/site";
import {
  gscOauthApp,
  integrationStatus,
  invalidateIntegrationCache,
  getIntegrationRow,
  type IntegrationProvider,
} from "../lib/siteIntegrations";

const router: IRouter = Router();

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

function signState(payload: { siteId: number; userId: string; exp: number }): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", stateSecret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verifyState(state: string): { siteId: number; userId: string } | null {
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
    };
    if (
      typeof payload.siteId !== "number" ||
      typeof payload.userId !== "string" ||
      typeof payload.exp !== "number" ||
      payload.exp < Date.now()
    ) {
      return null;
    }
    return { siteId: payload.siteId, userId: payload.userId };
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
    const state = signState({
      siteId: site.id,
      userId: site.ownerUserId!,
      exp: Date.now() + STATE_TTL_MS,
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

    await upsertIntegration(
      verified.siteId,
      "gsc",
      { refreshToken },
      { property, availableProperties: properties.slice(0, 100) },
    );
    req.log.info(
      { siteId: verified.siteId, property, propertyCount: properties.length },
      "GSC connected",
    );
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

// ---- Disconnect ---------------------------------------------------------------

router.delete("/integrations/:provider", requireAuth, requireSite, async (req, res, next) => {
  try {
    const site = getSite(req);
    const provider = req.params["provider"];
    if (provider !== "gsc" && provider !== "ga4" && provider !== "bing") {
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
    req.log.info({ siteId: site.id, provider }, "integration disconnected");
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
