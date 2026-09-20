import { Router } from "express";
import { authenticate, AuthRequest } from "../middleware/authenticate";
import { registerDevice, removeDevice, getPrefs, setPrefs, sendOnce } from "../services/push";
import { startPushJobs } from "../jobs/pushJobs";

/**
 * Push notification endpoints. Mounted under /api/analysis/push by the
 * analysis router, so index.ts does not need to change.
 *
 *   POST   /token   register this phone's Expo push token
 *   DELETE /token   forget it (on log out)
 *   GET    /prefs   which alerts are on
 *   PATCH  /prefs   turn alerts on or off
 *   POST   /test    send yourself a test notification
 */
export const pushRouter = Router();

pushRouter.post("/token", authenticate, async (req: AuthRequest, res, next) => {
  try {
    await registerDevice(req.userId!, String(req.body?.token || ""), String(req.body?.platform || ""));
    res.json({ ok: true });
  } catch (e: any) {
    if (e?.message === "Not a valid push token") return res.status(400).json({ error: e.message });
    next(e);
  }
});

pushRouter.delete("/token", authenticate, async (req: AuthRequest, res, next) => {
  try {
    if (req.body?.token) await removeDevice(String(req.body.token));
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

pushRouter.get("/prefs", authenticate, async (req: AuthRequest, res, next) => {
  try {
    res.json(await getPrefs(req.userId!));
  } catch (e) {
    next(e);
  }
});

pushRouter.patch("/prefs", authenticate, async (req: AuthRequest, res, next) => {
  try {
    res.json({ prefs: await setPrefs(req.userId!, req.body?.prefs) });
  } catch (e) {
    next(e);
  }
});

pushRouter.post("/test", authenticate, async (req: AuthRequest, res, next) => {
  try {
    await sendOnce(req.userId!, "test:" + Date.now(), "test",
      "Notifications are on",
      "You will hear from Clashd before deadlines, when your captain is a doubt, and when results land.",
      { screen: "home" });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// The scheduled pushes start with the server.
startPushJobs();
