import { Router } from "express";
import { prisma } from "../utils/prisma";
import { authenticate, AuthRequest } from "../middleware/authenticate";
import { AppError } from "../utils/AppError";
import { fplService } from "../services/fpl";
import { withRank } from "../utils/ranking";

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

    // FPL numbers a manager's picks 1 to 15: 1-11 is the side that started and
    // 12-15 is the bench, in the order the subs would come on. That ordering was
    // discarded here, which left the app with no way to tell a starter from a
    // substitute - every squad arrived as one flat list. Carrying it through
    // costs nothing and is what lets the pitch draw a bench.
    //
    // Note the name clash: `p.position` is the 1-15 pick order, while
    // `meta.position` is the FPL element_type (1=GK 2=DEF 3=MID 4=FWD).
    const squad = rawPicks
      .map((p) => {
        const meta = playerMap[p.element];
        if (!meta) return null;
        const fplOrder = Number(p.position) || 0;
        return {
          id: meta.id,
          name: meta.name,
          team: meta.team,
          position: meta.position,
          slot: SLOT_BY_TYPE[meta.position],
          fplOrder,
          startedForFpl: fplOrder > 0 && fplOrder <= 11,
          benchOrder: fplOrder > 11 ? fplOrder - 11 : null,
          isCaptain: !!p.is_captain,
          isViceCaptain: !!p.is_vice_captain,
        };
      })
      .filter((x: any) => !!x)
      .sort((a: any, b: any) => a.fplOrder - b.fplOrder);

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
      // The side's total, so the team view can show what it is worth without
      // a second request. Written by the scoring job once the gameweek runs;
      // zero and unscored until then, which is the honest state rather than a
      // blank.
      score: existing ? existing.score : 0,
      scored: existing ? !!existing.scoredAt : false,
      invalidCount: existing ? existing.invalidCount : 0,
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
      standings: withRank(picks, (p) => p.score).map((p) => ({
        rank: p.rank,
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

/* -- one against one -------------------------------------------------------

   Aside on its own is solitaire: pick a side, get a number, see where the
   number came. This is the other way to play it - your five against one other
   manager's five, inside a competition you are both already in.

   Both sides are blind. Picks are secret until the deadline, and a challenge
   has to be asked for and accepted before it, so nobody is answering with
   knowledge of the other team. After the gameweek is scored the result is
   settled from the two Aside scores, and the running record between those two
   managers is what makes it worth playing twice.

     GET  /api/aside/challenges/:leagueId     mine this gameweek, plus who is
                                              left to challenge
     POST /api/aside/challenge                ask for one
     POST /api/aside/challenge/:id/respond    accept or decline
                                                                            */

/** The gameweek a challenge would be for, and whether it is still open. */
async function challengeWindow() {
  const next_ = await fplService.getNextGameweek();
  if (!next_) return null;
  return {
    gameweek: next_.id,
    deadline: next_.deadline,
    locked: new Date(next_.deadline).getTime() <= Date.now(),
  };
}

/** Settled results between two managers, from whichever side asked. */
async function recordBetween(leagueId: string, a: string, b: string) {
  const rows = await prisma.asideChallenge.findMany({
    where: {
      leagueId,
      status: "SETTLED",
      OR: [
        { challengerId: a, opponentId: b },
        { challengerId: b, opponentId: a },
      ],
    },
    select: { challengerId: true, challengerScore: true, opponentScore: true },
  });

  let won = 0, drew = 0, lost = 0;
  for (const r of rows) {
    const mine = r.challengerId === a ? r.challengerScore : r.opponentScore;
    const theirs = r.challengerId === a ? r.opponentScore : r.challengerScore;
    if (mine == null || theirs == null) continue;
    if (mine > theirs) won++;
    else if (mine < theirs) lost++;
    else drew++;
  }
  return { won, drew, lost, played: won + drew + lost };
}

function who(u: any) {
  return { id: u.id, name: u.fplTeamName || u.displayName, manager: u.displayName };
}

asideRouter.get("/challenges/:leagueId", authenticate, async (req: AuthRequest, res, next) => {
  try {
    const league = await prisma.league.findUnique({ where: { id: req.params.leagueId } });
    if (!league) return next(new AppError("League not found.", 404));
    if (!ASIDE_FORMATS.includes(league.format)) {
      return next(new AppError("This competition does not play one against one.", 400));
    }

    const win = await challengeWindow();
    if (!win) return next(new AppError("No upcoming gameweek available.", 503));

    const me = req.userId!;

    const mine = await prisma.asideChallenge.findMany({
      where: {
        leagueId: league.id,
        OR: [{ challengerId: me }, { opponentId: me }],
      },
      include: {
        challenger: { select: { id: true, displayName: true, fplTeamName: true } },
        opponent: { select: { id: true, displayName: true, fplTeamName: true } },
      },
      orderBy: [{ gameweek: "desc" }, { createdAt: "desc" }],
      take: 40,
    });

    const shaped = mine.map((c) => {
      const iAsked = c.challengerId === me;
      const them = iAsked ? c.opponent : c.challenger;
      const myScore = iAsked ? c.challengerScore : c.opponentScore;
      const theirScore = iAsked ? c.opponentScore : c.challengerScore;
      return {
        id: c.id,
        gameweek: c.gameweek,
        status: c.status,
        iAsked,
        /** Only the person who was asked may answer, and only while open. */
        canRespond: !iAsked && c.status === "PENDING" && c.gameweek === win.gameweek && !win.locked,
        them: who(them),
        myScore,
        theirScore,
        result:
          c.status !== "SETTLED" || myScore == null || theirScore == null
            ? null
            : myScore > theirScore ? "WON" : myScore < theirScore ? "LOST" : "DREW",
      };
    });

    // Everybody else in the competition, minus anyone this gameweek already
    // has a challenge with either way round.
    const entries = await prisma.entry.findMany({
      where: { leagueId: league.id, userId: { not: me } },
      include: { user: { select: { id: true, displayName: true, fplTeamName: true } } },
    });
    const taken = new Set(
      mine.filter((c) => c.gameweek === win.gameweek)
        .map((c) => (c.challengerId === me ? c.opponentId : c.challengerId))
    );

    const candidates = await Promise.all(
      entries
        .filter((e) => !taken.has(e.userId))
        .map(async (e) => ({
          ...who(e.user),
          record: await recordBetween(league.id, me, e.userId),
        }))
    );

    res.json({
      gameweek: win.gameweek,
      deadline: win.deadline,
      locked: win.locked,
      challenges: shaped,
      candidates: candidates.sort((a, b) => b.record.played - a.record.played),
    });
  } catch (e) { next(e); }
});

asideRouter.post("/challenge", authenticate, async (req: AuthRequest, res, next) => {
  try {
    const leagueId = String((req.body as any)?.leagueId || "");
    const opponentId = String((req.body as any)?.opponentId || "");
    const me = req.userId!;

    if (!leagueId || !opponentId) {
      return next(new AppError("Pick somebody to challenge.", 400));
    }
    if (opponentId === me) {
      return next(new AppError("You cannot challenge yourself.", 400));
    }

    const league = await prisma.league.findUnique({ where: { id: leagueId } });
    if (!league) return next(new AppError("League not found.", 404));
    if (!ASIDE_FORMATS.includes(league.format)) {
      return next(new AppError("This competition does not play one against one.", 400));
    }

    const win = await challengeWindow();
    if (!win) return next(new AppError("No upcoming gameweek available.", 503));
    if (win.locked) {
      return next(new AppError(
        "The deadline has passed. Challenges have to be agreed before it, or one of you would be picking with the other's team in front of them.",
        400));
    }

    // Both of them have to actually be in this competition.
    const both = await prisma.entry.findMany({
      where: { leagueId, userId: { in: [me, opponentId] } },
      select: { userId: true },
    });
    if (both.length !== 2) {
      return next(new AppError("You can only challenge somebody in the same competition.", 400));
    }

    // One per pair per gameweek, whichever way round it was asked.
    const existing = await prisma.asideChallenge.findFirst({
      where: {
        leagueId, gameweek: win.gameweek,
        OR: [
          { challengerId: me, opponentId },
          { challengerId: opponentId, opponentId: me },
        ],
      },
    });
    if (existing) {
      return next(new AppError("You already have one with them this gameweek.", 409));
    }

    const challenge = await prisma.asideChallenge.create({
      data: { leagueId, gameweek: win.gameweek, challengerId: me, opponentId },
    });

    const asker = await prisma.user.findUnique({
      where: { id: me },
      select: { displayName: true, fplTeamName: true },
    });
    const askerName = asker?.fplTeamName || asker?.displayName || "Someone";

    await prisma.notification.create({
      data: {
        userId: opponentId,
        title: askerName + " has challenged you",
        body:
          askerName + " wants to play you head to head in " + league.name +
          " for Gameweek " + win.gameweek + ". Your " + totalSlots(formationFor(league)) +
          " against theirs. Accept before the deadline.",
        type: "league_update",
        metadata: { leagueId, challengeId: challenge.id } as any,
      },
    });

    res.status(201).json({ ok: true, challenge: { id: challenge.id, status: challenge.status } });
  } catch (e) { next(e); }
});

asideRouter.post("/challenge/:id/respond", authenticate, async (req: AuthRequest, res, next) => {
  try {
    const accept = (req.body as any)?.accept === true;
    const me = req.userId!;

    const challenge = await prisma.asideChallenge.findUnique({
      where: { id: req.params.id },
      include: { league: { select: { id: true, name: true, format: true } } },
    });
    if (!challenge) return next(new AppError("Challenge not found.", 404));

    // Only the person who was asked gets to answer it.
    if (challenge.opponentId !== me) {
      return next(new AppError("That challenge is not yours to answer.", 403));
    }
    if (challenge.status !== "PENDING") {
      return next(new AppError("That has already been answered.", 409));
    }

    const win = await challengeWindow();
    if (!win || challenge.gameweek !== win.gameweek || win.locked) {
      await prisma.asideChallenge.update({
        where: { id: challenge.id },
        data: { status: "VOID", respondedAt: new Date() },
      });
      return next(new AppError("Too late - that one was for a gameweek that has closed.", 400));
    }

    const updated = await prisma.asideChallenge.update({
      where: { id: challenge.id },
      data: { status: accept ? "ACCEPTED" : "DECLINED", respondedAt: new Date() },
    });

    if (accept) {
      const them = await prisma.user.findUnique({
        where: { id: me },
        select: { displayName: true, fplTeamName: true },
      });
      const name = them?.fplTeamName || them?.displayName || "They";
      await prisma.notification.create({
        data: {
          userId: challenge.challengerId,
          title: name + " accepted",
          body:
            "You are on for Gameweek " + challenge.gameweek + " in " +
            challenge.league.name + ". Pick your side before the deadline.",
          type: "league_update",
          metadata: { leagueId: challenge.leagueId, challengeId: challenge.id } as any,
        },
      });
    }

    res.json({ ok: true, status: updated.status });
  } catch (e) { next(e); }
});
