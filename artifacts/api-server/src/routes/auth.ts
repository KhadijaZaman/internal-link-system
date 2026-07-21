import { Router, type IRouter } from "express";
import { getUserId } from "../lib/auth";

const router: IRouter = Router();

/**
 * Auth state endpoint. Login/logout are handled entirely by Clerk on the
 * client (session cookie), so the API only reports the current state.
 */
router.get("/auth/me", (req, res) => {
  const userId = getUserId(req);
  if (!userId) {
    res.json({ authenticated: false, username: null });
    return;
  }
  res.json({ authenticated: true, username: userId });
});

export default router;
