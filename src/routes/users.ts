import { Router } from "express";
import { prisma } from "../utils/prisma";
import { authenticate, AuthRequest } from "../middleware/authenticate";
import { AppError } from "../utils/AppError";

export const usersRouter = Router();

usersRouter.get("/profile", authenticate, async (req: AuthRequest, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      include: { _count: { select: { entries: true } } },
    });
    const { passwordHash, ...safe } = user as any;
    res.json(safe);
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
