import { Router } from "express";
import { prisma } from "../utils/prisma";
import { authenticate, AuthRequest } from "../middleware/authenticate";

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