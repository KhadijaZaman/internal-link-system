import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { getUserId } from "../lib/auth";

const router: IRouter = Router();

/**
 * Auth state endpoint. Login/logout are handled entirely by Clerk on the
 * client (session cookie), so the API only reports the current state.
 * `isAdmin` gates the Admin link in the dashboard sidebar (the admin API
 * itself is enforced server-side by requireAdmin regardless).
 */
router.get("/auth/me", async (req, res) => {
  const userId = getUserId(req);
  if (!userId) {
    res.json({ authenticated: false, username: null, isAdmin: false });
    return;
  }
  const [row] = await db
    .select({ isAdmin: usersTable.isAdmin })
    .from(usersTable)
    .where(eq(usersTable.id, userId));
  res.json({ authenticated: true, username: userId, isAdmin: row?.isAdmin ?? false });
});

export default router;
