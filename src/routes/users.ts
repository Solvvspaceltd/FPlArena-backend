import { Router } from "express";
import { prisma } from "../utils/prisma";
import { authenticate, AuthRequest } from "../middleware/authenticate";
import { AppError } from "../utils/AppError";
import { fplService } from "../services/fpl";

export const usersRouter = Router();

usersRouter.get("/profile", authenticate, async (req: AuthRequest, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      include: { _count: { select: { entries: true } } },
    });
    if (!user) return next(new AppError("User not found.", 404));
    const { passwordHash, ...safe } = user as any;

    // The app's Home tiles need this gameweek's points, which live on gwScore
    // rather than the user row. Without it the GW tile can only ever show zero.
    let gameweekPoints = 0;
    let currentGameweek: number | null = null;
    try {
      currentGameweek = await fplService.getCurrentGameweek();
    } catch (e) {
      // FPL being unavailable must not break the profile call.
    }

    // Season total from our own scores rather than the user row. FPL does not
    // add a gameweek to its history endpoint until that gameweek is finished,
    // so relying on it leaves the season total at zero all week while the
    // current gameweek is being played.
    const scores = await prisma.gwScore.findMany({
      where: { entry: { userId: req.userId } },
      select: { gameweek: true, points: true },
      orderBy: { syncedAt: "desc" },
    });

    // A user in six leagues has six rows per gameweek with the same score, so
    // take one per gameweek before summing.
    const byGameweek = new Map<number, number>();
    for (const row of scores) {
      if (!byGameweek.has(row.gameweek)) byGameweek.set(row.gameweek, row.points);
    }
    const seasonPoints = Array.from(byGameweek.values()).reduce((a, b) => a + b, 0);
    if (currentGameweek) gameweekPoints = byGameweek.get(currentGameweek) ?? 0;

    res.json({
      ...safe,
      totalPoints: Math.max(safe.totalPoints || 0, seasonPoints),
      currentGameweek,
      gameweekPoints,
    });
  } catch (e) { next(e); }
});

usersRouter.get("/leaderboard", authenticate, async (_req, res, next) => {
  try {
    const users = await prisma.user.findMany({
      where: { fplTeamId: { not: null }, platformRank: { not: null } },
      select: {
        id: true, displayName: true, fplTeamName: true, avatarUrl: true,
        totalPoints: true, platformRank: true,
      },
      orderBy: { platformRank: "asc" },
      take: 100,
    });
    res.json(users);
  } catch (e) { next(e); }
});

/**
 * Account deletion, requested by the account holder.
 *
 * Apple's App Store guideline 5.1.1(v) requires any app offering account
 * creation to offer account deletion in-app, so this must exist and must
 * actually remove the account rather than just deactivating it.
 *
 * Removes all of the user's own data. Leagues they created are reassigned to
 * an admin so other players' competitions are not destroyed along with them.
 */
usersRouter.delete("/me", authenticate, async (req: AuthRequest, res, next) => {
  try {
    const userId = req.userId!;

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return next(new AppError("Account not found.", 404));

    if (user.role === "ADMIN") {
      const adminCount = await prisma.user.count({ where: { role: "ADMIN" } });
      if (adminCount <= 1) {
        return next(new AppError("The last admin account cannot be deleted.", 400));
      }
    }

    const fallbackAdmin = await prisma.user.findFirst({
      where: { role: "ADMIN", id: { not: userId } },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });

    await prisma.$transaction(async (tx) => {
      const entries = await tx.entry.findMany({
        where: { userId },
        select: { id: true },
      });
      const entryIds = entries.map((e) => e.id);
      if (entryIds.length > 0) {
        await tx.gwScore.deleteMany({ where: { entryId: { in: entryIds } } });
      }
      await tx.asidePick.deleteMany({ where: { userId } });
      await tx.squadSnapshot.deleteMany({ where: { userId } });
      await tx.entry.deleteMany({ where: { userId } });
      await tx.notification.deleteMany({ where: { userId } });

      if (fallbackAdmin) {
        await tx.league.updateMany({
          where: { createdById: userId },
          data: { createdById: fallbackAdmin.id },
        });
      }

      await tx.user.delete({ where: { id: userId } });
    });

    res.json({ message: "Your account and all associated data have been deleted." });
  } catch (e) {
    next(e);
  }
});
