import { db, siteIntegrationsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { LEGACY_SITE_ID } from "./site";

/**
 * Per-site integration credential resolution. Integration code (GSC, GA4,
 * Bing) calls these with the site id it is operating on; a per-site
 * `site_integrations` row wins, and the historical env vars are used as a
 * fallback for the legacy site (id 1) ONLY. Any other site without a row
 * throws a clear "not connected" error — credentials must never silently
 * cross tenants.
 */

export type IntegrationProvider = "gsc" | "ga4" | "bing";

export class IntegrationNotConnectedError extends Error {
  provider: IntegrationProvider;
  constructor(provider: IntegrationProvider, siteId: number) {
    super(
      `${provider.toUpperCase()} is not connected for site ${siteId} — connect it in Settings → Connections`,
    );
    this.provider = provider;
    this.name = "IntegrationNotConnectedError";
  }
}

// Short TTL cache so hot read routes don't hit the DB per request.
const TTL_MS = 30_000;
const cache = new Map<string, { row: IntegrationRowLite | null; expiresAt: number }>();

interface IntegrationRowLite {
  credentials: Record<string, unknown>;
  config: Record<string, unknown>;
}

export function invalidateIntegrationCache(siteId: number, provider?: IntegrationProvider): void {
  if (provider) {
    cache.delete(`${siteId}|${provider}`);
  } else {
    for (const key of cache.keys()) {
      if (key.startsWith(`${siteId}|`)) cache.delete(key);
    }
  }
}

export async function getIntegrationRow(
  siteId: number,
  provider: IntegrationProvider,
): Promise<IntegrationRowLite | null> {
  const key = `${siteId}|${provider}`;
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.row;
  const rows = await db
    .select({
      credentials: siteIntegrationsTable.credentials,
      config: siteIntegrationsTable.config,
    })
    .from(siteIntegrationsTable)
    .where(
      and(
        eq(siteIntegrationsTable.siteId, siteId),
        eq(siteIntegrationsTable.provider, provider),
      ),
    )
    .limit(1);
  const row =
    rows.length > 0
      ? {
          credentials: (rows[0].credentials ?? {}) as Record<string, unknown>,
          config: (rows[0].config ?? {}) as Record<string, unknown>,
        }
      : null;
  cache.set(key, { row, expiresAt: Date.now() + TTL_MS });
  return row;
}

// ---------------------------------------------------------------------------
// GSC
// ---------------------------------------------------------------------------

export interface GscCreds {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** GSC property, e.g. "sc-domain:example.com" or "https://example.com/". */
  property: string;
}

/** The shared Google OAuth app used for all per-site GSC connections. */
export function gscOauthApp(): { clientId: string; clientSecret: string } {
  const clientId = process.env["GSC_CLIENT_ID"];
  const clientSecret = process.env["GSC_CLIENT_SECRET"];
  if (!clientId || !clientSecret) {
    throw new Error("GSC_CLIENT_ID / GSC_CLIENT_SECRET must be set");
  }
  return { clientId, clientSecret };
}

export async function getGscCreds(siteId: number): Promise<GscCreds> {
  const row = await getIntegrationRow(siteId, "gsc");
  if (row) {
    const refreshToken = row.credentials["refreshToken"];
    const property = row.config["property"];
    if (typeof refreshToken === "string" && refreshToken) {
      if (typeof property !== "string" || !property) {
        throw new Error(
          `GSC is connected for site ${siteId} but no property is selected — pick one in Settings → Connections`,
        );
      }
      const app = gscOauthApp();
      return { ...app, refreshToken, property };
    }
  }
  if (siteId === LEGACY_SITE_ID) {
    const refreshToken = process.env["GSC_REFRESH_TOKEN"];
    const property = process.env["GSC_PROPERTY"];
    if (refreshToken && property) {
      const app = gscOauthApp();
      return { ...app, refreshToken, property };
    }
  }
  throw new IntegrationNotConnectedError("gsc", siteId);
}

// ---------------------------------------------------------------------------
// GA4
// ---------------------------------------------------------------------------

export interface Ga4Creds {
  clientEmail: string;
  privateKey: string;
  propertyId: string;
}

export async function getGa4Creds(siteId: number): Promise<Ga4Creds> {
  const row = await getIntegrationRow(siteId, "ga4");
  if (row) {
    const clientEmail = row.credentials["clientEmail"];
    const privateKey = row.credentials["privateKey"];
    const propertyId = row.config["propertyId"];
    if (
      typeof clientEmail === "string" &&
      typeof privateKey === "string" &&
      typeof propertyId === "string" &&
      clientEmail &&
      privateKey &&
      propertyId
    ) {
      return { clientEmail, privateKey, propertyId };
    }
  }
  if (siteId === LEGACY_SITE_ID) {
    const raw = process.env["GA4_SERVICE_ACCOUNT_JSON"];
    const propertyId = process.env["GA4_PROPERTY_ID"];
    if (raw && propertyId) {
      let parsed: { client_email?: string; private_key?: string };
      try {
        parsed = JSON.parse(raw) as { client_email?: string; private_key?: string };
      } catch {
        throw new Error("GA4_SERVICE_ACCOUNT_JSON is not valid JSON");
      }
      if (!parsed.client_email || !parsed.private_key) {
        throw new Error("GA4_SERVICE_ACCOUNT_JSON missing client_email/private_key");
      }
      return {
        clientEmail: parsed.client_email,
        privateKey: parsed.private_key,
        propertyId: propertyId.replace(/^properties\//, "").trim(),
      };
    }
  }
  throw new IntegrationNotConnectedError("ga4", siteId);
}

// ---------------------------------------------------------------------------
// Bing
// ---------------------------------------------------------------------------

export async function getBingApiKey(siteId: number): Promise<string> {
  const row = await getIntegrationRow(siteId, "bing");
  if (row) {
    const apiKey = row.credentials["apiKey"];
    if (typeof apiKey === "string" && apiKey) return apiKey;
  }
  if (siteId === LEGACY_SITE_ID) {
    const k = process.env["BING_WEBMASTER_API_KEY"];
    if (k) return k;
  }
  throw new IntegrationNotConnectedError("bing", siteId);
}

/** Non-throwing connected check used by the status endpoint. */
export async function integrationStatus(siteId: number): Promise<{
  gsc: { connected: boolean; property: string | null; needsProperty: boolean };
  ga4: { connected: boolean; propertyId: string | null };
  bing: { connected: boolean };
}> {
  const [gscRow, ga4Row, bingRow] = await Promise.all([
    getIntegrationRow(siteId, "gsc"),
    getIntegrationRow(siteId, "ga4"),
    getIntegrationRow(siteId, "bing"),
  ]);

  const isLegacy = siteId === LEGACY_SITE_ID;

  let gsc: { connected: boolean; property: string | null; needsProperty: boolean };
  if (gscRow && typeof gscRow.credentials["refreshToken"] === "string") {
    const property =
      typeof gscRow.config["property"] === "string" ? (gscRow.config["property"] as string) : null;
    gsc = { connected: true, property, needsProperty: property === null };
  } else if (isLegacy && process.env["GSC_REFRESH_TOKEN"] && process.env["GSC_PROPERTY"]) {
    gsc = { connected: true, property: process.env["GSC_PROPERTY"] ?? null, needsProperty: false };
  } else {
    gsc = { connected: false, property: null, needsProperty: false };
  }

  let ga4: { connected: boolean; propertyId: string | null };
  if (ga4Row && typeof ga4Row.credentials["privateKey"] === "string") {
    ga4 = {
      connected: true,
      propertyId:
        typeof ga4Row.config["propertyId"] === "string"
          ? (ga4Row.config["propertyId"] as string)
          : null,
    };
  } else if (isLegacy && process.env["GA4_SERVICE_ACCOUNT_JSON"] && process.env["GA4_PROPERTY_ID"]) {
    ga4 = { connected: true, propertyId: process.env["GA4_PROPERTY_ID"] ?? null };
  } else {
    ga4 = { connected: false, propertyId: null };
  }

  const bing =
    (bingRow && typeof bingRow.credentials["apiKey"] === "string") ||
    (isLegacy && !!process.env["BING_WEBMASTER_API_KEY"])
      ? { connected: true }
      : { connected: false };

  return { gsc, ga4, bing };
}
