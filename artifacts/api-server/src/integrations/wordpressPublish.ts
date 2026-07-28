// Publishing to WordPress via the REST API with an Application Password.
// Separate from wordpress.ts (which is the read-only public-content crawler).
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { getWpCreds, type WpCreds } from "../lib/siteIntegrations";

// ---------------------------------------------------------------------------
// SSRF guard: the base URL is user-supplied, so every request to it must be
// HTTPS to a publicly routable host — never loopback, private, link-local, or
// cloud-metadata ranges. DNS is re-resolved at request time (not just at
// save time) to close the rebinding window.
// ---------------------------------------------------------------------------

function ipIsPrivate(addr: string): boolean {
  if (addr.startsWith("::ffff:")) addr = addr.slice(7);
  if (isIP(addr) === 4) {
    const p = addr.split(".").map(Number);
    return (
      p[0] === 0 ||
      p[0] === 10 ||
      p[0] === 127 ||
      (p[0] === 100 && p[1] >= 64 && p[1] <= 127) || // CGNAT
      (p[0] === 169 && p[1] === 254) || // link-local / cloud metadata
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) ||
      (p[0] === 192 && p[1] === 0 && p[2] === 0) ||
      (p[0] === 198 && (p[1] === 18 || p[1] === 19)) ||
      p[0] >= 224 // multicast / reserved / broadcast
    );
  }
  const lower = addr.toLowerCase();
  return (
    lower === "::" ||
    lower === "::1" ||
    lower.startsWith("fe80:") || // link-local
    lower.startsWith("fc") || // unique-local fc00::/7
    lower.startsWith("fd") ||
    lower.startsWith("fec0:")
  );
}

export class WpUrlBlockedError extends Error {}

/**
 * Validate a WordPress base URL and return its hostname. Throws
 * WpUrlBlockedError for anything not HTTPS on a public host.
 */
export async function assertSafeWpBaseUrl(baseUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new WpUrlBlockedError("Invalid site URL");
  }
  if (url.protocol !== "https:") {
    throw new WpUrlBlockedError("The WordPress site URL must use https://");
  }
  if (url.port && url.port !== "443") {
    throw new WpUrlBlockedError("Custom ports are not allowed for the WordPress site URL");
  }
  if (url.username || url.password) {
    throw new WpUrlBlockedError("Credentials are not allowed in the site URL");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (ipIsPrivate(host)) throw new WpUrlBlockedError("The site URL points at a private address");
    return;
  }
  if (!host.includes(".") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new WpUrlBlockedError("The site URL must be a public domain");
  }
  let addrs;
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    throw new WpUrlBlockedError("Could not resolve the WordPress site URL");
  }
  if (addrs.length === 0 || addrs.some((a) => ipIsPrivate(a.address))) {
    throw new WpUrlBlockedError("The site URL resolves to a private address");
  }
}

function authHeader(creds: WpCreds): string {
  return `Basic ${Buffer.from(`${creds.username}:${creds.appPassword}`).toString("base64")}`;
}

function apiBase(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/wp-json/wp/v2`;
}

export class WpApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function wpFetch(creds: WpCreds, path: string, init?: RequestInit): Promise<unknown> {
  // Re-validate on every call (not just at save time) to close DNS-rebinding
  // and stale-credential windows.
  await assertSafeWpBaseUrl(creds.baseUrl);
  const res = await fetch(`${apiBase(creds.baseUrl)}${path}`, {
    ...init,
    redirect: "error",
    headers: {
      Authorization: authHeader(creds),
      "Content-Type": "application/json",
      ...init?.headers,
    },
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const msg =
      body && typeof body["message"] === "string" ? (body["message"] as string) : res.statusText;
    throw new WpApiError(res.status, `WordPress API ${res.status}: ${msg}`);
  }
  return body;
}

/** Verify credentials with a live call; returns the WP display name. */
export async function verifyWpCreds(creds: WpCreds): Promise<string> {
  const me = (await wpFetch(creds, "/users/me?context=edit")) as { name?: string };
  return me.name ?? creds.username;
}

export interface PublishInput {
  title: string;
  contentHtml: string;
  status: "draft" | "publish";
  slug?: string | null;
  excerpt?: string | null;
}

export interface PublishResult {
  postId: number;
  link: string;
  status: string;
  editLink: string;
}

export async function publishPost(siteId: number, input: PublishInput): Promise<PublishResult> {
  const creds = await getWpCreds(siteId);
  const payload: Record<string, unknown> = {
    title: input.title,
    content: input.contentHtml,
    status: input.status,
  };
  if (input.slug) payload["slug"] = input.slug;
  if (input.excerpt) payload["excerpt"] = input.excerpt;
  const post = (await wpFetch(creds, "/posts", {
    method: "POST",
    body: JSON.stringify(payload),
  })) as { id: number; link: string; status: string };
  return {
    postId: post.id,
    link: post.link,
    status: post.status,
    editLink: `${creds.baseUrl.replace(/\/$/, "")}/wp-admin/post.php?post=${post.id}&action=edit`,
  };
}
