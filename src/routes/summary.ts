import { Router } from "express";
import { prisma } from "../utils/prisma";
import { authenticate, AuthRequest } from "../middleware/authenticate";
import { fplService } from "../services/fpl";

export const summaryRouter = Router();

/**
 * GET /api/summary
 *
 * One call that powers the Home summary block: the user's headline numbers, a
 * next-fixture line, recent form, and their position in every league they are
 * in. Everything the app needs to answer "how am I doing" without the screen
 * making five separate requests.
 */
summaryRouter.get("/", authenticate, async (req: AuthRequest, res, next) => {
  try {
    const userId = req.userId!;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        displayName: true,
        fplTeamName: true,
        fplTeamId: true,
        totalPoints: true,
        platformRank: true,
        previousRank: true,
      },
    });
    if (!user) return res.status(404).json({ error: "User not found." });

    let currentGameweek: number | null = null;
    let gameweekPoints = 0;
    try {
      currentGameweek = await fplService.getCurrentGameweek();
    } catch (e) {
      /* FPL down must not break the screen */
    }

    // This gameweek's points, from stored scores (live) rather than FPL history.
    if (currentGameweek) {
      const score = await prisma.gwScore.findFirst({
        where: { gameweek: currentGameweek, entry: { userId } },
        orderBy: { syncedAt: "desc" },
        select: { points: true },
      });
      gameweekPoints = score?.points ?? 0;
    }

    // Position in every league the user is in.
    const entries = await prisma.entry.findMany({
      where: { userId },
      include: {
        league: {
          select: { id: true, name: true, format: true, status: true },
        },
        division: { select: { id: true, name: true } },
      },
    });

    const leagues = await Promise.all(
      entries
        .filter((e) => e.league.status !== "COMPLETED")
        .map(async (e) => {
          // Rank within the league by its scoring number.
          const above = await prisma.entry.count({
            where: { leagueId: e.leagueId, totalPoints: { gt: e.totalPoints } },
          });
          const total = await prisma.entry.count({ where: { leagueId: e.leagueId } });
          return {
            leagueId: e.league.id,
            name: e.league.name,
            format: e.league.format,
            position: above + 1,
            total,
            points: e.totalPoints,
            leaguePoints: e.leaguePoints,
            division: e.division?.name || null,
          };
        })
    );

    // Best current standing, for the headline line.
    const best = leagues
      .slice()
      .sort((a, b) => a.position / a.total - b.position / b.total)[0];

    // Next fixture across the user's divisions.
    let nextFixture: any = null;
    const myEntryIds = entries.map((e) => e.id);
    if (myEntryIds.length) {
      const fx = await prisma.fixture.findFirst({
        where: {
          settled: false,
          OR: [
            { homeEntryId: { in: myEntryIds } },
            { awayEntryId: { in: myEntryIds } },
          ],
        },
        orderBy: { gameweek: "asc" },
        include: {
          homeEntry: { include: { user: { select: { displayName: true, fplTeamName: true } } } },
          awayEntry: { include: { user: { select: { displayName: true, fplTeamName: true } } } },
          division: { select: { name: true } },
        },
      });
      if (fx) {
        const iAmHome = myEntryIds.includes(fx.homeEntryId);
        const opp = iAmHome ? fx.awayEntry : fx.homeEntry;
        nextFixture = {
          gameweek: fx.gameweek,
          division: fx.division?.name || null,
          opponent: opp
            ? opp.user.fplTeamName || opp.user.displayName
            : "Bye",
        };
      }
    }

    // Last few settled results, for a form strip.
    let form: string[] = [];
    if (myEntryIds.length) {
      const recent = await prisma.fixture.findMany({
        where: {
          settled: true,
          OR: [
            { homeEntryId: { in: myEntryIds } },
            { awayEntryId: { in: myEntryIds } },
          ],
        },
        orderBy: { gameweek: "desc" },
        take: 5,
      });
      form = recent
        .map((f) => {
          const iAmHome = myEntryIds.includes(f.homeEntryId);
          const mine = iAmHome ? f.homePoints ?? 0 : f.awayPoints ?? 0;
          const theirs = iAmHome ? f.awayPoints ?? 0 : f.homePoints ?? 0;
          if (f.awayEntryId === null) return "W"; // bye
          return mine > theirs ? "W" : mine < theirs ? "L" : "D";
        })
        .reverse();
    }

    const rankMove =
      user.platformRank && user.previousRank
        ? user.previousRank - user.platformRank
        : 0;

    res.json({
      name: user.displayName,
      team: user.fplTeamName,
      linked: !!user.fplTeamId,
      currentGameweek,
      gameweekPoints,
      seasonPoints: user.totalPoints,
      platformRank: user.platformRank,
      rankMove,
      best: best
        ? { name: best.name, position: best.position, total: best.total }
        : null,
      nextFixture,
      form,
      leagues: leagues.sort((a, b) => a.position - b.position),
    });
  } catch (e) {
    next(e);
  }
});
