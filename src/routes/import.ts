import { Router } from "express";
import { prisma } from "../utils/prisma";
import { authenticate, AuthRequest } from "../middleware/authenticate";
import { AppError } from "../utils/AppError";
import { fplService } from "../services/fpl";
import {
  importMiniLeague,
  importedLeagueSummary,
} from "../services/leagueImport";

export const importRouter = Router();

/**
 * GET /api/import/preview?code=123456
 *
 * Look up an FPL mini-league before importing it. Returns the league name and
 * a COUNT of managers — never a roster. Nobody is named until they join Clashd
 * themselves.
 */
importRouter.get("/preview", authenticate, async (req: AuthRequest, res, next) => {
  try {
    const raw = String(req.query.code || "").trim();
    const fplLeagueId = parseInt(raw, 10);
    if (!fplLeagueId || isNaN(fplLeagueId)) {
      return next(new AppError("Enter your FPL mini-league ID.", 400));
    }

    const already = await prisma.league.findFirst({
      where: { importedFromFplId: fplLeagueId },
      select: { id: true, name: true },
    });

    const data = await fplService.getLeagueStandings(fplLeagueId, 1);
    if (!data?.league?.name) {
      return next(new AppError("Could not find a league with that ID.", 404));
    }

    const rows = data?.standings?.results || [];
    res.json({
      name: data.league.name,
      // A count, deliberately. Not a list of people.
      managers: rows.length + (data?.standings?.has_next ? 50 : 0),
      approximate: !!data?.standings?.has_next,
      alreadyImported: already ? { id: already.id, name: already.name } : null,
    });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/import
 * body: { code: number }
 *
 * Import the league. The caller becomes its admin.
 */
importRouter.post("/", authenticate, async (req: AuthRequest, res, next) => {
  try {
    const fplLeagueId = parseInt(String((req.body as any)?.code || ""), 10);
    if (!fplLeagueId || isNaN(fplLeagueId)) {
      return next(new AppError("Enter your FPL mini-league ID.", 400));
    }

    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { fplTeamId: true },
    });
    if (!user?.fplTeamId) {
      return next(new AppError("Link your FPL team before importing a league.", 400));
    }

    const result = await importMiniLeague(fplLeagueId, req.userId!);

    await prisma.notification.create({
      data: {
        userId: req.userId!,
        title: "League imported",
        body:
          `${result.name} is now on Clashd. ${result.onClashd} of ` +
          `${result.totalManagers} managers are already here; the rest join ` +
          `automatically when they sign up.`,
        type: "league_update",
        metadata: { leagueId: result.leagueId },
      },
    });

    res.status(201).json(result);
  } catch (e: any) {
    next(new AppError(e?.message || "Could not import that league.", 400));
  }
});

/** Count-only summary. Never a roster. */
importRouter.get("/:leagueId/summary", authenticate, async (req: AuthRequest, res, next) => {
  try {
    const summary = await importedLeagueSummary(req.params.leagueId);
    res.json(summary);
  } catch (e) {
    next(e);
  }
});
