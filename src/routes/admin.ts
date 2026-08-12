import { Router } from "express";
import { prisma } from "../utils/prisma";
import { authenticate } from "../middleware/authenticate";
import { requireAdmin } from "../middleware/requireAdmin";
import { AppError } from "../utils/AppError";

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

// Remove a user (admin only). Cleans up all related records first so no
// orphaned data is left behind. Guards: cannot remove yourself or another admin.
adminRouter.delete("/users/:id", async (req: any, res, next) => {
  try {
    const targetId = req.params.id;

    if (targetId === req.userId) {
      return next(new AppError("You cannot remove your own admin account.", 400));
    }

    const target = await prisma.user.findUnique({ where: { id: targetId } });
    if (!target) return next(new AppError("User not found.", 404));
    if (target.role === "ADMIN") {
      return next(new AppError("You cannot remove another admin.", 403));
    }

    // Delete in dependency order inside a transaction.
    await prisma.$transaction(async (tx) => {
      // 1. GwScores belong to the user's entries
      const entries = await tx.entry.findMany({
        where: { userId: targetId },
        select: { id: true },
      });
      const entryIds = entries.map((e) => e.id);
      if (entryIds.length > 0) {
        await tx.gwScore.deleteMany({ where: { entryId: { in: entryIds } } });
      }
      // 2. Entries
      await tx.entry.deleteMany({ where: { userId: targetId } });
      // 3. Notifications
      await tx.notification.deleteMany({ where: { userId: targetId } });
      // 4. Any leagues this user created (pilot users shouldn't have any,
      //    but clear the relation defensively by reassigning to remover).
      await tx.league.updateMany({
        where: { createdById: targetId },
        data: { createdById: req.userId },
      });
      // 5. Finally the user
      await tx.user.delete({ where: { id: targetId } });
    });

    res.json({ message: `Removed ${target.displayName} (${target.email}).`, id: targetId });
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
