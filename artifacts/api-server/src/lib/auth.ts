import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";

const COOKIE_NAME = "wellows_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;

function getSecret(): string {
  const s = process.env["SESSION_SECRET"];
  if (!s) throw new Error("SESSION_SECRET must be set");
  return s;
}

function sign(payload: string): string {
  return crypto.createHmac("sha256", getSecret()).update(payload).digest("hex");
}

export interface Session {
  username: string;
  issuedAt: number;
}

export function createSessionCookie(username: string): string {
  const payload = JSON.stringify({ username, issuedAt: Date.now() });
  const b64 = Buffer.from(payload, "utf8").toString("base64url");
  const sig = sign(b64);
  return `${b64}.${sig}`;
}

export function verifySessionCookie(cookie: string | undefined): Session | null {
  if (!cookie) return null;
  const parts = cookie.split(".");
  if (parts.length !== 2) return null;
  const [b64, sig] = parts;
  if (!b64 || !sig) return null;
  const expected = sign(b64);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const session = JSON.parse(Buffer.from(b64, "base64url").toString("utf8")) as Session;
    if (Date.now() - session.issuedAt > SESSION_TTL_MS) return null;
    return session;
  } catch {
    return null;
  }
}

export const SESSION_COOKIE_NAME = COOKIE_NAME;

export function getSession(req: Request): Session | null {
  const raw = (req as Request & { cookies?: Record<string, string> }).cookies?.[COOKIE_NAME];
  return verifySessionCookie(raw);
}

export function setSessionCookie(res: Response, username: string): void {
  const value = createSessionCookie(username);
  res.cookie(COOKIE_NAME, value, {
    httpOnly: true,
    sameSite: "none",
    secure: true,
    partitioned: true,
    maxAge: SESSION_TTL_MS,
    path: "/",
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    sameSite: "none",
    secure: true,
    partitioned: true,
    path: "/",
  });
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (getSession(req)) {
    next();
    return;
  }
  res.status(401).json({ error: "Unauthorized" });
}
