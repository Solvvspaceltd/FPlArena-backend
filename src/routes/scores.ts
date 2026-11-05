import { Router, Request, Response } from 'express';
import { prisma } from '../utils/prisma';
import { withRank } from '../utils/ranking';

export const scoresRouter = Router();

scoresRouter.get('/league/:leagueId/gameweek/:gw', async (req: Request, res: Response) => {
  try {
    const { leagueId, gw } = req.params;
    const scores = await prisma.gwScore.findMany({
      where: { leagueId, gameweek: parseInt(gw) },
      include: {
        entry: {
          include: {
            user: { select: { displayName: true, fplTeamName: true } },
          },
        },
      },
      orderBy: { points: 'desc' },
    });
    res.json(withRank(scores, (x) => x.points).map((s) => ({ ...s })));
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch scores' });
  }
});
