import type { Request, Response, NextFunction } from "express";
import { getAuth } from "@clerk/express";

/**
 * Clerk-based authentication. The Express app mounts `clerkMiddleware` in
 * app.ts; this helper reads the verified session from the request and
 * exposes the Clerk user id to downstream handlers as `req.userId`.
 *
 * Users are provisioned just-in-time into the local `users` table by
 * `requireAuth` (see ensureLocalUser) so that `sites.owner_user_id` has a
 * real row to reference.
 */

export interface AuthedRequest extends Request {
  userId?: string;
}

export function getUserId(req: Request): string | null {
  const auth = getAuth(req);
  return auth?.userId ?? null;
}

// JIT user provisioning: upsert the Clerk user into the local users table
// at most once per process per user (cheap in-memory guard).
const provisionedUsers = new Set<string>();

async function ensureLocalUser(userId: string): Promise<void> {
  if (provisionedUsers.has(userId)) return;
  const { db, usersTable } = await import("@workspace/db");
  await db
    .insert(usersTable)
    .values({ id: userId })
    .onConflictDoNothing({ target: usersTable.id });
  provisionedUsers.add(userId);
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const userId = getUserId(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  (req as AuthedRequest).userId = userId;
  ensureLocalUser(userId)
    .then(() => next())
    .catch((err) => next(err));
}
