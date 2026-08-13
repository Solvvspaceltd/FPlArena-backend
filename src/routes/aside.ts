import { Router } from "express";
import { prisma } from "../utils/prisma";
import { authenticate, AuthRequest } from "../middleware/authenticate";
import { AppError } from "../utils/AppError";
import { fplService } from "../services/fpl";

export const asideRouter = Router();

const ASIDE_FORMATS = ["SEVEN_ASIDE", "FIVE_ASIDE"];

const DEFAULT_FORMATIONS: Record<string, any> = {
  SEVEN_ASIDE: { gk: 1, def: 2, mid: 2, fwd: 2 },
  FIVE_ASIDE: { gk: 1, def: 1, mid: 2, fwd: 1 },
};

// element_type from FPL: 1=GK 2=DEF 3=MID 4=FWD
const SLOT_BY_TYPE: Record<number, string> = { 1: "gk", 2: "def", 3: "mid", 4: "fwd" };

function formationFor(league: any) {
  return (league.formationSpec as any) || DEFAULT_FORMATIONS[league.format] || DEFAULT_FORMATIONS.SEVEN_ASIDE;
}

function totalSlots(spec: any) {
  return (spec.gk || 0) + (spec.def || 0) + (spec.mid || 0) + (spec.fwd || 0);
}

/**
 * Returns the squad a user can pick from for a given Aside league, plus their
 * existing selection and the deadline.
 *
 * Squad source: the most recent SquadSnapshot we hold. Snapshots are captured
 * once a gameweek deadline passes (that is the only point FPL makes picks
 * public). If we have no snapshot yet, we try to build one on demand from the
 * most recent gameweek whose deadline has passed.
 */
asideRouter.get("/squad/:leagueId", authenticate, async (req: AuthRequest, res, next) => {
  try {
    const league = await prisma.league.findUnique({ where: { id: req.params.leagueId } });
    if (!league) return next(new AppError("League not found.", 404));
    if (!ASIDE_FORMATS.includes(league.format)) {
      return next(new AppError("This league does not use squad selection.", 400));
    }

    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user?.fplTeamId) {
      return next(new AppError("Link your FPL team before selecting a squad.", 400));
    }

    const entry = await prisma.entry.findUnique({
      where: { userId_leagueId: { userId: req.userId!, leagueId: league.id } },
    });
    if (!entry) return next(new AppError("Join this league before selecting a squad.", 400));

    const next_ = await fplService.getNextGameweek();
    if (!next_) return next(new AppError("No upcoming gameweek available.", 503));
    const targetGw = next_.id;

    if (targetGw < league.startGameweek || targetGw > league.endGameweek) {
      return next(new AppError("This league is not active for the upcoming gameweek.", 400));
    }

    // Most recent snapshot we hold for this user.
    let snapshot = await prisma.squadSnapshot.findFirst({
      where: { userId: req.userId },
      orderBy: { gameweek: "desc" },
    });

    // No snapshot: build one from the latest gameweek whose deadline has passed.
    if (!snapshot) {
      for (let gw = targetGw - 1; gw >= 1 && gw >= targetGw - 3; gw--) {
        const passed = await fplService.isDeadlinePassed(gw);
        if (!passed) continue;
        const picks = await fplService.getGwPicks(user.fplTeamId, gw);
        if (picks?.picks?.length) {
          snapshot = await prisma.squadSnapshot.create({
            data: { userId: req.userId!, gameweek: gw, picks: picks.picks },
          });
          break;
        }
      }
    }

    if (!snapshot) {
      return res.json({
        available: false,
        reason: "Your squad becomes available once the first gameweek deadline has passed.",
        gameweek: targetGw,
        deadline: next_.deadline,
        formation: formationFor(league),
        squad: [],
        selection: [],
      });
    }

    const playerMap = await fplService.getPlayerMap();
    const rawPicks: any[] = snapshot.picks as any[];
    const squad = rawPicks
      .map((p) => {
        const meta = playerMap[p.element];
        if (!meta) return null;
        return {
          id: meta.id,
          name: meta.name,
          team: meta.team,
          position: meta.position,
          slot: SLOT_BY_TYPE[meta.position],
        };
      })
      .filter(Boolean);

    const existing = await prisma.asidePick.findUnique({
      where: {
        userId_leagueId_gameweek: {
          userId: req.userId!,
          leagueId: league.id,
          gameweek: targetGw,
        },
      },
    });

    const deadlinePassed = new Date(next_.deadline).getTime() <= Date.now();

    res.json({
      available: true,
      gameweek: targetGw,
      deadline: next_.deadline,
      locked: deadlinePassed,
      snapshotGameweek: snapshot.gameweek,
      formation: formationFor(league),
      squad,
      selection: existing ? (existing.playerIds as number[]) : [],
    });
  } catch (e) {
    next(e);
  }
});

/**
 * Saves an Aside selection. Validates the formation and that every chosen
 * player is genuinely in the user's snapshot squad. Rejects after deadline.
 */
asideRouter.post("/pick", authenticate, async (req: AuthRequest, res, next) => {
  try {
    const { leagueId, playerIds } = req.body as { leagueId: string; playerIds: number[] };
    if (!leagueId || !Array.isArray(playerIds)) {
      return next(new AppError("leagueId and playerIds are required.", 400));
    }

    const league = await prisma.league.findUnique({ where: { id: leagueId } });
    if (!league) return next(new AppError("League not found.", 404));
    if (!ASIDE_FORMATS.includes(league.format)) {
      return next(new AppError("This league does not use squad selection.", 400));
    }

    const entry = await prisma.entry.findUnique({
      where: { userId_leagueId: { userId: req.userId!, leagueId } },
    });
    if (!entry) return next(new AppError("Join this league before selecting a squad.", 400));

    const next_ = await fplService.getNextGameweek();
    if (!next_) return next(new AppError("No upcoming gameweek available.", 503));
    if (new Date(next_.deadline).getTime() <= Date.now()) {
      return next(new AppError("The deadline for this gameweek has passed.", 400));
    }
    const targetGw = next_.id;

    const spec = formationFor(league);
    const required = totalSlots(spec);
    const unique = Array.from(new Set(playerIds));
    if (unique.length !== playerIds.length) {
      return next(new AppError("Duplicate players in selection.", 400));
    }
    if (playerIds.length !== required) {
      return next(new AppError(`Select exactly ${required} players.`, 400));
    }

    const snapshot = await prisma.squadSnapshot.findFirst({
      where: { userId: req.userId },
      orderBy: { gameweek: "desc" },
    });
    if (!snapshot) return next(new AppError("No squad available yet.", 400));

    const squadIds = new Set((snapshot.picks as any[]).map((p) => p.element));
    for (const id of playerIds) {
      if (!squadIds.has(id)) {
        return next(new AppError("You can only pick players from your own squad.", 400));
      }
    }

    // Formation check
    const playerMap = await fplService.getPlayerMap();
    const counts: Record<string, number> = { gk: 0, def: 0, mid: 0, fwd: 0 };
    for (const id of playerIds) {
      const meta = playerMap[id];
      if (!meta) return next(new AppError("Unknown player in selection.", 400));
      counts[SLOT_BY_TYPE[meta.position]]++;
    }
    for (const slot of ["gk", "def", "mid", "fwd"]) {
      if ((counts[slot] || 0) !== (spec[slot] || 0)) {
        return next(
          new AppError(
            `Formation must be ${spec.gk} GK, ${spec.def} DEF, ${spec.mid} MID, ${spec.fwd} FWD.`,
            400
          )
        );
      }
    }

    const saved = await prisma.asidePick.upsert({
      where: {
        userId_leagueId_gameweek: { userId: req.userId!, leagueId, gameweek: targetGw },
      },
      update: { playerIds },
      create: { userId: req.userId!, leagueId, gameweek: targetGw, playerIds },
    });

    res.json({ message: "Selection saved.", gameweek: targetGw, playerIds: saved.playerIds });
  } catch (e) {
    next(e);
  }
});

/** Standings for an Aside league, for a specific gameweek or the latest scored one. */
asideRouter.get("/leaderboard/:leagueId", authenticate, async (req: AuthRequest, res, next) => {
  try {
    const league = await prisma.league.findUnique({ where: { id: req.params.leagueId } });
    if (!league) return next(new AppError("League not found.", 404));

    const gwParam = req.query.gw ? parseInt(String(req.query.gw), 10) : null;
    let gameweek = gwParam;
    if (!gameweek) {
      const latest = await prisma.asidePick.findFirst({
        where: { leagueId: league.id, scoredAt: { not: null } },
        orderBy: { gameweek: "desc" },
        select: { gameweek: true },
      });
      gameweek = latest?.gameweek ?? null;
    }

    if (!gameweek) return res.json({ gameweek: null, standings: [] });

    const picks = await prisma.asidePick.findMany({
      where: { leagueId: league.id, gameweek },
      include: { user: { select: { displayName: true, fplTeamName: true } } },
      orderBy: { score: "desc" },
    });

    res.json({
      gameweek,
      payingPlaces: league.payingPlaces,
      standings: picks.map((p, i) => ({
        rank: i + 1,
        name: p.user.displayName,
        teamName: p.user.fplTeamName,
        score: p.score,
        invalidCount: p.invalidCount,
        scored: !!p.scoredAt,
      })),
    });
  } catch (e) {
    next(e);
  }
});
