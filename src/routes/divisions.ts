import { Router } from "express";
import { prisma } from "../utils/prisma";
import { placeUnassignedEntries, regenerateRemainingFixtures } from "../services/lateJoiners";
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

    // Every division in the current cycle, so a manager can see the tier below
    // and what they are climbing towards. A pyramid only feels like one if you
    // can see the rest of it.
    const allDivisions = await prisma.division.findMany({
      where: { leagueId, cycle: division.cycle },
      orderBy: { tier: "asc" },
    });

    const tables = await Promise.all(
      allDivisions.map(async (d) => {
        const rows = await prisma.entry.findMany({
          where: { divisionId: d.id },
          orderBy: [{ leaguePoints: "desc" }, { totalPoints: "desc" }],
          include: { user: { select: { id: true, displayName: true, fplTeamName: true } } },
        });
        const divFixtures = await prisma.fixture.findMany({
          where: { divisionId: d.id },
          orderBy: [{ gameweek: "asc" }],
          include: {
            homeEntry: { include: { user: { select: { displayName: true, fplTeamName: true } } } },
            awayEntry: { include: { user: { select: { displayName: true, fplTeamName: true } } } },
          },
        });

        return {
          id: d.id,
          name: d.name,
          tier: d.tier,
          isMine: d.id === division.id,
          fixtures: divFixtures.map((f) => ({
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
          })),
          standings: rows.map((e, i) => ({
            position: i + 1,
            entryId: e.id,
            userId: e.user.id,
            name: e.user.displayName,
            team: e.user.fplTeamName,
            played: e.played,
            won: e.won,
            drawn: e.drawn,
            lost: e.lost,
            leaguePoints: e.leaguePoints,
            totalPoints: e.totalPoints,
            mine: e.user.id === req.userId,
          })),
        };
      })
    );

    // Promotion and relegation from the most recent completed cycle. Comparing
    // a manager's tier now against their tier in the previous cycle tells us
    // who went up and who went down.
    let movements: any[] = [];
    if (division.cycle > 1) {
      const prev = await prisma.division.findMany({
        where: { leagueId, cycle: division.cycle - 1 },
        select: { id: true, tier: true },
      });
      const prevTierByEntryUser = new Map<string, number>();
      for (const p of prev) {
        const rows = await prisma.entry.findMany({
          where: { divisionId: p.id },
          select: { userId: true },
        });
        for (const r of rows) prevTierByEntryUser.set(r.userId, p.tier);
      }

      for (const d of allDivisions) {
        const rows = await prisma.entry.findMany({
          where: { divisionId: d.id },
          include: { user: { select: { id: true, displayName: true, fplTeamName: true } } },
        });
        for (const r of rows) {
          const was = prevTierByEntryUser.get(r.user.id);
          if (was == null || was === d.tier) continue;
          movements.push({
            team: r.user.fplTeamName || r.user.displayName,
            name: r.user.displayName,
            // A lower tier number is higher up the pyramid.
            direction: d.tier < was ? "promoted" : "relegated",
            to: d.name,
            mine: r.user.id === req.userId,
          });
        }
      }
      movements.sort((a, b) => (a.direction === "promoted" ? -1 : 1));
    }

    res.json({
      available: true,
      tables,
      movements,
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

/**
 * Place any entries that have no division yet (late joiners), and generate
 * their fixtures. Admin only. Also runs automatically on join and daily.
 */
divisionsRouter.post("/:leagueId/place-joiners", authenticate, requireAdmin,
  async (req: AuthRequest, res, next) => {
    try {
      const result = await placeUnassignedEntries(req.params.leagueId);
      res.json({
        message: result.placed
          ? `Placed ${result.placed} late joiner(s).`
          : "Everyone already has a division.",
        ...result,
      });
    } catch (e) {
      next(e);
    }
  });

/**
 * Rebuild the remaining fixtures for every division in a league, from the next
 * gameweek onwards. Settled results are preserved.
 *
 * Needed when a division's membership has changed since its fixtures were
 * generated, or when a cycle has simply run out. Admin only.
 */
divisionsRouter.post("/:leagueId/rebuild-fixtures", authenticate, requireAdmin,
  async (req: AuthRequest, res, next) => {
    try {
      const divisions = await prisma.division.findMany({
        where: { leagueId: req.params.leagueId },
        select: { id: true, name: true },
      });
      if (!divisions.length) {
        return next(new AppError("That league has no divisions.", 404));
      }

      let gw = 1;
      try {
        const current = await fplService.getCurrentGameweek();
        if (current) gw = current + 1;
      } catch (e) { /* fall back to 1 */ }

      const results: any[] = [];
      for (const d of divisions) {
        const made = await regenerateRemainingFixtures(d.id, gw);
        results.push({ division: d.name, fixtures: made });
      }

      res.json({
        message: `Rebuilt fixtures from GW${gw}.`,
        fromGameweek: gw,
        divisions: results,
      });
    } catch (e) {
      next(e);
    }
  });
