import { Router } from "express";
import { prisma } from "../utils/prisma";
import { authenticate, AuthRequest } from "../middleware/authenticate";
import { requireAdmin } from "../middleware/requireAdmin";
import { AppError } from "../utils/AppError";
import { fplService } from "../services/fpl";
import {
  buildDivisions,
  settleFixtures,
  runPromotionRelegation,
  MIN_DIVISION_SIZE,
} from "../services/divisions";

export const divisionsRouter = Router();

/**
 * GET /api/divisions/:leagueId
 *
 * Everything the league screen needs: the caller's division, its standings,
 * their own fixture this gameweek, and the rest of the round.
 */
divisionsRouter.get("/:leagueId", authenticate, async (req: AuthRequest, res, next) => {
  try {
    const leagueId = req.params.leagueId;

    const myEntry = await prisma.entry.findUnique({
      where: { userId_leagueId: { userId: req.userId!, leagueId } },
      select: { id: true, divisionId: true },
    });

    // Fall back to the top division so people can look before they join.
    const division = myEntry?.divisionId
      ? await prisma.division.findUnique({ where: { id: myEntry.divisionId } })
      : await prisma.division.findFirst({
          where: { leagueId },
          orderBy: [{ cycle: "desc" }, { tier: "asc" }],
        });

    if (!division) {
      const memberCount = await prisma.entry.count({ where: { leagueId } });
      return res.json({
        available: false,
        memberCount,
        minimum: MIN_DIVISION_SIZE,
        reason:
          memberCount < MIN_DIVISION_SIZE
            ? `Fixtures start once this league has ${MIN_DIVISION_SIZE} members.`
            : "Fixtures have not been generated for this league yet.",
      });
    }

    const standings = await prisma.entry.findMany({
      where: { divisionId: division.id },
      orderBy: [{ leaguePoints: "desc" }, { totalPoints: "desc" }],
      include: { user: { select: { id: true, displayName: true, fplTeamName: true } } },
    });

    let currentGameweek: number | null = null;
    try {
      currentGameweek = await fplService.getCurrentGameweek();
    } catch (e) {
      /* FPL being down must not break the screen */
    }

    const fixtures = await prisma.fixture.findMany({
      where: { divisionId: division.id },
      orderBy: [{ gameweek: "asc" }],
      include: {
        homeEntry: { include: { user: { select: { displayName: true, fplTeamName: true } } } },
        awayEntry: { include: { user: { select: { displayName: true, fplTeamName: true } } } },
      },
    });

    const shape = (f: any) => ({
      id: f.id,
      round: f.round,
      gameweek: f.gameweek,
      settled: f.settled,
      home: {
        entryId: f.homeEntryId,
        name: f.homeEntry?.user?.displayName || "",
        team: f.homeEntry?.user?.fplTeamName || "",
        points: f.homePoints,
      },
      away: f.awayEntryId
        ? {
            entryId: f.awayEntryId,
            name: f.awayEntry?.user?.displayName || "",
            team: f.awayEntry?.user?.fplTeamName || "",
            points: f.awayPoints,
          }
        : null,
    });

    const mine = myEntry
      ? fixtures.filter(
          (f) => f.homeEntryId === myEntry.id || f.awayEntryId === myEntry.id
        )
      : [];

    res.json({
      available: true,
      division: {
        id: division.id,
        name: division.name,
        tier: division.tier,
        cycle: division.cycle,
        startGameweek: division.startGameweek,
        endGameweek: division.endGameweek,
      },
      currentGameweek,
      myEntryId: myEntry?.id || null,
      standings: standings.map((e, i) => ({
        position: i + 1,
        entryId: e.id,
        userId: e.user.id,
        name: e.user.displayName,
        team: e.user.fplTeamName,
        played: e.played,
        won: e.won,
        drawn: e.drawn,
        lost: e.lost,
        points: e.leaguePoints,
        seasonPoints: e.totalPoints,
      })),
      myFixtures: mine.map(shape),
      fixtures: fixtures.map(shape),
    });
  } catch (e) {
    next(e);
  }
});

/** POST /api/divisions/:leagueId/build — admin: create divisions and fixtures. */
divisionsRouter.post(
  "/:leagueId/build",
  authenticate,
  requireAdmin,
  async (req: AuthRequest, res, next) => {
    try {
      const { startGameweek } = req.body as any;
      let start = parseInt(String(startGameweek ?? ""), 10);

      if (isNaN(start)) {
        const next_ = await fplService.getNextGameweek();
        start = next_?.id ?? 1;
      }
      if (start < 1 || start > 38) {
        return next(new AppError("Start gameweek must be between 1 and 38.", 400));
      }

      const result = await buildDivisions(req.params.leagueId, start);
      if (result.divisions === 0) {
        return next(new AppError(result.reason || "Not enough members.", 400));
      }

      res.json({
        message: `Created ${result.divisions} division(s) and ${result.fixtures} fixtures from GW${start}.`,
        ...result,
      });
    } catch (e) {
      next(e);
    }
  }
);

/** POST /api/divisions/settle — admin: settle a gameweek's fixtures now. */
divisionsRouter.post("/settle", authenticate, requireAdmin, async (req: AuthRequest, res, next) => {
  try {
    const { gameweek } = req.body as any;
    let gw = parseInt(String(gameweek ?? ""), 10);
    if (isNaN(gw)) gw = (await fplService.getCurrentGameweek()) ?? 1;

    const settled = await settleFixtures(gw);
    res.json({ message: `Settled ${settled} fixture(s) for GW${gw}.`, settled, gameweek: gw });
  } catch (e) {
    next(e);
  }
});

/** POST /api/divisions/:leagueId/promote — admin: run promotion and relegation. */
divisionsRouter.post(
  "/:leagueId/promote",
  authenticate,
  requireAdmin,
  async (req: AuthRequest, res, next) => {
    try {
      const next_ = await fplService.getNextGameweek();
      const result = await runPromotionRelegation(req.params.leagueId, next_?.id ?? 1);
      if (!result.moved) {
        return next(new AppError(result.reason || "Nothing to promote yet.", 400));
      }
      res.json({ message: `Cycle ${result.cycle} created.`, ...result });
    } catch (e) {
      next(e);
    }
  }
);
