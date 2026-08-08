import { Router } from 'express';
import { prisma } from '../utils/prisma';
import { authenticate } from '../middleware/authenticate';
import { AppError } from '../utils/AppError';
import { fplService } from '../services/fpl';

export const scoresRouter = Router();

// GET /api/scores/league/:id — full leaderboard for a league
scoresRouter.get('/league/:id', authenticate, async (req, res, next) => {
  try {
    const entries = await prisma.entry.findMany({
      where: { leagueId: req.params.id, status: 'ACTIVE' },
      include: {
        user: { select: { displayName: true, fplTeamName: true, avatarUrl: true } },
        gwScores: { orderBy: { gameweek: 'desc' }, take: 5 },
      },
      orderBy: { totalPoints: 'desc' },
    });

    res.json(entries.map((e, i) => ({
      rank: i + 1,
      entryId: e.id,
      userId: e.userId,
      displayName: e.user.displayName,
      fplTeamName: e.user.fplTeamName,
      avatarUrl: e.user.avatarUrl,
      totalPoints: e.totalPoints,
      highestGwScore: e.highestGwScore,
      movement: e.previousRank ? e.previousRank - (i + 1) : 0,
      recentScores: e.gwScores.map(s => ({ gameweek: s.gameweek, points: s.points })),
    })));
  } catch (e) { next(e); }
});

// GET /api/scores/league/:id/gw/:gw — scores for a specific GW
scoresRouter.get('/league/:id/gw/:gw', authenticate, async (req, res, next) => {
  try {
    const { id, gw } = req.params;
    const scores = await prisma.gwScore.findMany({
      where: { leagueId: id, gameweek: parseInt(gw) },
      include: {
        entry: {
          include: { user: { select: { displayName: true, fplTeamName: true } } },
        },
      },
      orderBy: { points: 'desc' },
    });
    res.json(scores.map((s, i) => ({
      rank: i + 1,
      gameweek: s.gameweek,
      points: s.points,
      transfersMade: s.transfersMade,
      pointsOnBench: s.pointsOnBench,
      displayName: s.entry.user.displayName,
      fplTeamName: s.entry.user.fplTeamName,
      entryId: s.entryId,
    })));
  } catch (e) { next(e); }
});

// GET /api/scores/current-gw — what GW are we on?
scoresRouter.get('/current-gw', authenticate, async (_req, res, next) => {
  try {
    const gw = await fplService.getCurrentGameweek();
    const bootstrap = await fplService.getBootstrap();
    const current = bootstrap.events.find(e => e.is_current);
    res.json({
      currentGameweek: gw,
      deadline: current?.deadline_time,
      averageScore: current?.average_entry_score,
      highestScore: current?.highest_score,
    });
  } catch (e) { next(e); }
});