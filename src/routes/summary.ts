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
        avatarId: true,
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

    // Highest score any Clashd player has this gameweek — a target on the Home
    // screen. Deduped isn't needed: max is max even across duplicate rows.
    let gameweekHigh = 0;
    if (currentGameweek) {
      const top = await prisma.gwScore.findFirst({
        where: { gameweek: currentGameweek },
        orderBy: { points: "desc" },
        select: { points: true },
      });
      gameweekHigh = top?.points ?? 0;
    }

    // Did this user post the joint-highest score in the current gameweek? Drives
    // the celebration when they open the app. Only when the gameweek has scores.
    let isGameweekWinner = false;
    if (currentGameweek && gameweekHigh > 0 && gameweekPoints === gameweekHigh) {
      isGameweekWinner = true;
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

    const activeEntries = entries.filter((e) => e.league.status !== "COMPLETED");
    const leagueIds = activeEntries.map((e) => e.leagueId);
    const divisionIds = activeEntries
      .map((e) => e.divisionId)
      .filter((d): d is string => !!d);

    // TWO bulk queries instead of four counts per league. Pull every entry in the
    // relevant leagues and divisions once, then rank in memory. This was the main
    // cause of the slow Home load: a user in 10 leagues fired ~40 round-trips.
    const [leagueEntries, divisionEntries] = await Promise.all([
      prisma.entry.findMany({
        where: { leagueId: { in: leagueIds } },
        select: { leagueId: true, totalPoints: true },
      }),
      divisionIds.length
        ? prisma.entry.findMany({
            where: { divisionId: { in: divisionIds } },
            select: { divisionId: true, leaguePoints: true },
          })
        : Promise.resolve([] as { divisionId: string | null; leaguePoints: number }[]),
    ]);

    // Group once.
    const byLeague = new Map<string, number[]>();
    for (const e of leagueEntries) {
      if (!byLeague.has(e.leagueId)) byLeague.set(e.leagueId, []);
      byLeague.get(e.leagueId)!.push(e.totalPoints);
    }
    const byDivision = new Map<string, number[]>();
    for (const e of divisionEntries) {
      if (!e.divisionId) continue;
      if (!byDivision.has(e.divisionId)) byDivision.set(e.divisionId, []);
      byDivision.get(e.divisionId)!.push(e.leaguePoints);
    }

    const leagues = activeEntries.map((e) => {
      const pts = byLeague.get(e.leagueId) || [];
      const total = pts.length;
      const position = pts.filter((p) => p > e.totalPoints).length + 1;

      let tablePosition: number | null = null;
      let tableTotal: number | null = null;
      if (e.divisionId) {
        const lp = byDivision.get(e.divisionId) || [];
        tableTotal = lp.length;
        tablePosition = lp.filter((p) => p > e.leaguePoints).length + 1;
      }

      return {
        leagueId: e.league.id,
        name: e.league.name,
        format: e.league.format,
        position,
        total,
        tablePosition,
        tableTotal,
        points: e.totalPoints,
        leaguePoints: e.leaguePoints,
        division: e.division?.name || null,
        // Movement vs previous rank, for the arrow indicator on Home.
        rankDelta: (e as any).previousRank && (e as any).currentRank
          ? (e as any).previousRank - (e as any).currentRank
          : 0,
      };
    });

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
        const oppEntry = iAmHome ? fx.awayEntry : fx.homeEntry;
        const oppEntryId = iAmHome ? fx.awayEntryId : fx.homeEntryId;

        // Opponent's last five results in the same division.
        let oppForm: string[] = [];
        if (oppEntryId) {
          const oppRecent = await prisma.fixture.findMany({
            where: {
              settled: true,
              OR: [{ homeEntryId: oppEntryId }, { awayEntryId: oppEntryId }],
            },
            orderBy: { gameweek: "desc" },
            take: 5,
          });
          oppForm = oppRecent
            .map((f) => {
              const home = f.homeEntryId === oppEntryId;
              const mine2 = home ? f.homePoints ?? 0 : f.awayPoints ?? 0;
              const theirs2 = home ? f.awayPoints ?? 0 : f.homePoints ?? 0;
              if (f.awayEntryId === null) return "W";
              return mine2 > theirs2 ? "W" : mine2 < theirs2 ? "L" : "D";
            })
            .reverse();
        }

        nextFixture = {
          gameweek: fx.gameweek,
          division: fx.division?.name || null,
          opponent: oppEntry
            ? oppEntry.user.fplTeamName || oppEntry.user.displayName
            : "Bye",
          opponentForm: oppForm,
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

    // Rank movement from the user's entries, which carry previousRank. Take the
    // largest positive swing so the Home "moved" figure is encouraging.
    let rankMove = 0;
    for (const e of entries) {
      if (e.previousRank && e.currentRank) {
        const swing = e.previousRank - e.currentRank;
        if (swing > rankMove) rankMove = swing;
      }
    }

    // Points per gameweek for the Home stats chart. One row per gameweek.
    const scoreRows = await prisma.gwScore.findMany({
      where: { entry: { userId } },
      select: { gameweek: true, points: true },
      orderBy: { gameweek: "asc" },
    });
    const gwMap = new Map<number, number>();
    for (const r of scoreRows) if (!gwMap.has(r.gameweek)) gwMap.set(r.gameweek, r.points);
    const pointsSeries = Array.from(gwMap.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([gameweek, points]) => ({ gameweek, points }));

    let bestGw: { gameweek: number; points: number } | null = null;
    let worstGw: { gameweek: number; points: number } | null = null;
    for (const pt of pointsSeries) {
      if (!bestGw || pt.points > bestGw.points) bestGw = pt;
      if (!worstGw || pt.points < worstGw.points) worstGw = pt;
    }
    const avgPoints = pointsSeries.length
      ? Math.round(pointsSeries.reduce((a, b) => a + b.points, 0) / pointsSeries.length)
      : 0;

    res.json({
      name: user.displayName,
      team: user.fplTeamName,
      avatarId: user.avatarId,
      linked: !!user.fplTeamId,
      currentGameweek,
      gameweekPoints,
      gameweekHigh,
      isGameweekWinner,
      seasonPoints: user.totalPoints,
      platformRank: user.platformRank,
      rankMove,
      best: best
        ? { name: best.name, position: best.position, total: best.total }
        : null,
      nextFixture,
      form,
      pointsSeries,
      bestGw,
      worstGw,
      avgPoints,
      leagues: leagues.sort((a, b) => a.position - b.position),
    });
  } catch (e) {
    next(e);
  }
});
