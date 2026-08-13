import { Router } from "express";
import { prisma } from "../utils/prisma";
import { authenticate, AuthRequest } from "../middleware/authenticate";
import { requireAdmin } from "../middleware/requireAdmin";
import { generateInviteCode } from "../utils/inviteCode";
import { AppError } from "../utils/AppError";

export const leaguesRouter = Router();

// Browse all leagues (authenticated users)
leaguesRouter.get("/", authenticate, async (req: AuthRequest, res, next) => {
  try {
    const leagues = await prisma.league.findMany({
      include: {
        _count: { select: { entries: true } },
        createdBy: { select: { displayName: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    // Which leagues has this user already joined?
    const myEntries = await prisma.entry.findMany({
      where: { userId: req.userId },
      select: { leagueId: true },
    });
    const joinedIds = new Set(myEntries.map(e => e.leagueId));
    res.json(leagues.map(l => ({
      ...l,
      entryCount: l._count.entries,
      joined: joinedIds.has(l.id),
    })));
  } catch (e) { next(e); }
});

// League detail + leaderboard
leaguesRouter.get("/:id", authenticate, async (req: AuthRequest, res, next) => {
  try {
    const league = await prisma.league.findUnique({
      where: { id: req.params.id },
      include: {
        entries: {
          include: { user: { select: { displayName: true, fplTeamName: true, avatarUrl: true } } },
          orderBy: { totalPoints: "desc" },
        },
        _count: { select: { entries: true } },
      },
    });
    if (!league) throw new AppError("League not found", 404);

    const leaderboard = league.entries.map((e, i) => ({
      rank: i + 1,
      entryId: e.id,
      userId: e.userId,
      displayName: e.user.displayName,
      fplTeamName: e.user.fplTeamName,
      avatarUrl: e.user.avatarUrl,
      totalPoints: e.totalPoints,
      previousRank: e.previousRank,
      movement: e.previousRank ? e.previousRank - (i + 1) : 0,
    }));

    res.json({ ...league, entries: undefined, leaderboard, entryCount: league._count.entries });
  } catch (e) { next(e); }
});

// Join via invite code
leaguesRouter.post("/join", authenticate, async (req: AuthRequest, res, next) => {
  try {
    const { inviteCode } = req.body;
    if (!inviteCode) throw new AppError("Invite code required");

    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user?.fplTeamId) throw new AppError("Link your FPL team before joining a league");

    const league = await prisma.league.findUnique({ where: { inviteCode: inviteCode.toUpperCase() } });
    if (!league) throw new AppError("Invalid invite code", 404);
    if (league.status === "COMPLETED") throw new AppError("This league has ended");

    const existing = await prisma.entry.findUnique({
      where: { userId_leagueId: { userId: req.userId!, leagueId: league.id } },
    });
    if (existing) throw new AppError("Already in this league", 409);

    const entry = await prisma.entry.create({
      data: { userId: req.userId!, leagueId: league.id },
    });

    // Notify all league members
    await prisma.notification.create({
      data: {
        userId: req.userId!,
        title: "League joined",
        body: `You joined ${league.name}. Good luck!`,
        type: "league_update",
        metadata: { leagueId: league.id },
      },
    });

    res.status(201).json({ message: `Joined ${league.name}`, entry });
  } catch (e) { next(e); }
});

// My leagues
leaguesRouter.get("/my/list", authenticate, async (req: AuthRequest, res, next) => {
  try {
    const entries = await prisma.entry.findMany({
      where: { userId: req.userId! },
      include: {
        league: { include: { _count: { select: { entries: true } } } },
      },
      orderBy: { joinedAt: "desc" },
    });

    res.json(entries.map(e => ({
      entryId: e.id,
      leagueId: e.league.id,
      leagueName: e.league.name,
      leagueStatus: e.league.status,
      inviteCode: e.league.inviteCode,
      prizeInfo: e.league.prizeInfo,
      totalPoints: e.totalPoints,
      currentRank: e.currentRank,
      entryCount: e.league._count.entries,
      season: e.league.season,
    })));
  } catch (e) { next(e); }
});

// GW scores for a league
leaguesRouter.get("/:id/gameweek/:gw", authenticate, async (_req, res, next) => {
  try {
    const { id, gw } = _req.params;
    const scores = await prisma.gwScore.findMany({
      where: { leagueId: id, gameweek: parseInt(gw) },
      include: {
        entry: { include: { user: { select: { displayName: true, fplTeamName: true } } } },
      },
      orderBy: { points: "desc" },
    });
    res.json(scores.map((s, i) => ({ rank: i + 1, ...s })));
  } catch (e) { next(e); }
});

// ── Admin routes ────────────────────────────────────────────────

// Create league (admin only)
leaguesRouter.post("/", authenticate, requireAdmin, async (req: AuthRequest, res, next) => {
  try {
    const { name, description, season, startGameweek, endGameweek, prizeInfo } = req.body;
    if (!name || !season || !startGameweek || !endGameweek)
      throw new AppError("name, season, startGameweek, endGameweek required");

    const league = await prisma.league.create({
      data: {
        name, description, season, prizeInfo,
        startGameweek: parseInt(startGameweek),
        endGameweek: parseInt(endGameweek),
        inviteCode: generateInviteCode(),
        createdById: req.userId!,
      },
    });
    res.status(201).json(league);
  } catch (e) { next(e); }
});

// Update league status (admin only)
leaguesRouter.patch("/:id/status", authenticate, requireAdmin, async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!["UPCOMING", "ACTIVE", "COMPLETED"].includes(status))
      throw new AppError("Invalid status");
    const league = await prisma.league.update({
      where: { id: req.params.id },
      data: { status },
    });
    res.json(league);
  } catch (e) { next(e); }
});