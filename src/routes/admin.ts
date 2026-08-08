import { Router } from "express";
import { prisma } from "../utils/prisma";
import { authenticate } from "../middleware/authenticate";
import { requireAdmin } from "../middleware/requireAdmin";

export const adminRouter = Router();
adminRouter.use(authenticate, requireAdmin);

adminRouter.get("/stats", async (_req, res, next) => {
  try {
    const [users, leagues, entries, syncs] = await Promise.all([
      prisma.user.count(),
      prisma.league.count(),
      prisma.entry.count(),
      prisma.fplSync.findMany({ orderBy: { syncedAt: "desc" }, take: 10 }),
    ]);
    const linked = await prisma.user.count({ where: { fplTeamId: { not: null } } });
    res.json({ users, linked, leagues, entries, recentSyncs: syncs });
  } catch (e) { next(e); }
});

adminRouter.get("/users", async (_req, res, next) => {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true, email: true, displayName: true, fplTeamId: true,
        fplTeamName: true, role: true, createdAt: true,
        _count: { select: { entries: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    res.json(users);
  } catch (e) { next(e); }
});

// Manually trigger a score sync (useful for testing)
adminRouter.post("/sync", async (_req, res, next) => {
  try {
    const { fplService } = await import("../services/fpl");
    const gw = await fplService.getCurrentGameweek();
    res.json({ message: `Current GW: ${gw}. Sync will run on next cron tick.` });
  } catch (e) { next(e); }
});