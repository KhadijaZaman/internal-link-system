import { Router, type IRouter } from "express";
import rateLimit from "express-rate-limit";
import { LoginBody } from "@workspace/api-zod";
import {
  clearSessionCookie,
  getSession,
  setSessionCookie,
} from "../lib/auth";

const router: IRouter = Router();

const loginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many login attempts, please try again later" },
});

router.post("/auth/login", loginRateLimit, (req, res) => {
  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const expected = process.env["ADMIN_PASSWORD"]?.trim();
  if (!expected) {
    res.status(500).json({ error: "ADMIN_PASSWORD not configured" });
    return;
  }
  if (parsed.data.password !== expected) {
    res.status(401).json({ error: "Invalid password" });
    return;
  }
  setSessionCookie(res, "admin");
  res.json({ authenticated: true, username: "admin" });
});

router.post("/auth/logout", (_req, res) => {
  clearSessionCookie(res);
  res.json({ status: "ok" });
});

router.get("/auth/me", (req, res) => {
  const s = getSession(req);
  if (!s) {
    res.json({ authenticated: false, username: null });
    return;
  }
  res.json({ authenticated: true, username: s.username });
});

export default router;
