import { Router } from "express";
import { prisma } from "../utils/prisma";
import { authenticate } from "../middleware/authenticate";
import { requireAdmin } from "../middleware/requireAdmin";
import { AppError } from "../utils/AppError";

export const adminRouter = Router();
adminRouter.use(authenticate, requireAdmin);

adminRouter.get("/stats", async (_req, res, next) => {
  try {
    const [users, leagues, entries, syncs] = await Promise.all([
      prisma.user.count(),
      prisma.league.count(),
      prisma.entry.count(),
      prisma.fplSync.findMany({ orderBy: { syncedAt: "desc" }, take: 10 }),
    ]);
    const linked = await prisma.user.count({ where: { fplTeamId: { not: null } } });
    res.json({ users, linked, leagues, entries, recentSyncs: syncs });
  } catch (e) { next(e); }
});

adminRouter.get("/users", async (_req, res, next) => {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true, email: true, displayName: true, fplTeamId: true,
        fplTeamName: true, role: true, createdAt: true,
        _count: { select: { entries: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    res.json(users);
  } catch (e) { next(e); }
});

// Remove a user (admin only). Cleans up all related records first so no
// orphaned data is left behind. Guards: cannot remove yourself or another admin.
adminRouter.delete("/users/:id", async (req: any, res, next) => {
  try {
    const targetId = req.params.id;

    if (targetId === req.userId) {
      return next(new AppError("You cannot remove your own admin account.", 400));
    }

    const target = await prisma.user.findUnique({ where: { id: targetId } });
    if (!target) return next(new AppError("User not found.", 404));
    if (target.role === "ADMIN") {
      return next(new AppError("You cannot remove another admin.", 403));
    }

    // Delete in dependency order inside a transaction.
    await prisma.$transaction(async (tx) => {
      // 1. GwScores belong to the user's entries
      const entries = await tx.entry.findMany({
        where: { userId: targetId },
        select: { id: true },
      });
      const entryIds = entries.map((e) => e.id);
      if (entryIds.length > 0) {
        await tx.gwScore.deleteMany({ where: { entryId: { in: entryIds } } });
      }
      // 2. Entries
      await tx.entry.deleteMany({ where: { userId: targetId } });
      // 3. Notifications
      await tx.notification.deleteMany({ where: { userId: targetId } });
      // 4. Any leagues this user created (pilot users shouldn't have any,
      //    but clear the relation defensively by reassigning to remover).
      await tx.league.updateMany({
        where: { createdById: targetId },
        data: { createdById: req.userId },
      });
      // 5. Finally the user
      await tx.user.delete({ where: { id: targetId } });
    });

    res.json({ message: `Removed ${target.displayName} (${target.email}).`, id: targetId });
  } catch (e) { next(e); }
});


// ── Promote an existing user to admin, or demote back to player ──────────────
adminRouter.patch("/users/:id/role", async (req: any, res, next) => {
  try {
    const { role } = req.body as { role: string };
    if (!["ADMIN", "PLAYER"].includes(role)) {
      return next(new AppError("Role must be ADMIN or PLAYER.", 400));
    }

    const target = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!target) return next(new AppError("User not found.", 404));

    if (target.id === req.userId && role === "PLAYER") {
      return next(new AppError("You cannot remove your own admin access.", 400));
    }

    // Never allow the last admin to be demoted.
    if (target.role === "ADMIN" && role === "PLAYER") {
      const adminCount = await prisma.user.count({ where: { role: "ADMIN" } });
      if (adminCount <= 1) {
        return next(new AppError("There must be at least one admin.", 400));
      }
    }

    const updated = await prisma.user.update({
      where: { id: target.id },
      data: { role: role as any },
      select: { id: true, email: true, displayName: true, role: true },
    });

    res.json({
      message:
        role === "ADMIN"
          ? `${updated.displayName} is now an admin.`
          : `${updated.displayName} is now a player.`,
      user: updated,
    });
  } catch (e) {
    next(e);
  }
});

// ── Create a league ──────────────────────────────────────────────────────────
// An admin can only create a league using a format the scoring engine already
// understands. The description is text users read; the format is what runs.
const VALID_FORMATS = [
  "SEASON_TOTAL",
  "WEEKLY_HIGH",
  "CAPTAIN_POINTS",
  "TRANSFER_NET",
  "RANK_CLIMB",
  "NO_HITS",
  "SEVEN_ASIDE",
  "FIVE_ASIDE",
];

const DEFAULT_FORMATIONS: Record<string, any> = {
  SEVEN_ASIDE: { gk: 1, def: 2, mid: 2, fwd: 2 },
  FIVE_ASIDE: { gk: 1, def: 1, mid: 2, fwd: 1 },
};

adminRouter.post("/leagues", async (req: any, res, next) => {
  try {
    const {
      name,
      inviteCode,
      format,
      description,
      prizeInfo,
      startGameweek,
      endGameweek,
      payingPlaces,
      season,
      formationSpec,
    } = req.body as any;

    if (!name || !String(name).trim()) return next(new AppError("League name is required.", 400));
    if (!format || !VALID_FORMATS.includes(format)) {
      return next(new AppError("Choose a valid league format.", 400));
    }

    const start = parseInt(String(startGameweek ?? 1), 10);
    const end = parseInt(String(endGameweek ?? 38), 10);
    if (isNaN(start) || isNaN(end) || start < 1 || end > 38 || start > end) {
      return next(new AppError("Gameweek range must be between 1 and 38.", 400));
    }

    const places = parseInt(String(payingPlaces ?? 1), 10);
    if (isNaN(places) || places < 1 || places > 20) {
      return next(new AppError("Paying places must be between 1 and 20.", 400));
    }

    // Generate a code if one was not supplied, and make sure it is unique.
    let code = (inviteCode ? String(inviteCode) : "").trim().toUpperCase();
    if (!code) {
      code = "ARENA-" + Math.random().toString(36).substring(2, 8).toUpperCase();
    }
    if (!/^[A-Z0-9-]{4,24}$/.test(code)) {
      return next(new AppError("Invite code must be 4-24 letters, numbers or dashes.", 400));
    }
    const clash = await prisma.league.findUnique({ where: { inviteCode: code } });
    if (clash) return next(new AppError("That invite code is already in use.", 400));

    const league = await prisma.league.create({
      data: {
        name: String(name).trim(),
        inviteCode: code,
        format: format as any,
        formationSpec: formationSpec ?? DEFAULT_FORMATIONS[format] ?? undefined,
        description: description ? String(description).trim() : null,
        prizeInfo: prizeInfo ? String(prizeInfo).trim() : null,
        season: season ? String(season) : "2026/27",
        startGameweek: start,
        endGameweek: end,
        payingPlaces: places,
        status: "UPCOMING",
        createdById: req.userId,
      },
    });

    res.status(201).json({ message: `League "${league.name}" created.`, league });
  } catch (e) {
    next(e);
  }
});

// ── Update a league's status (open / activate / complete) ────────────────────
adminRouter.patch("/leagues/:id", async (req: any, res, next) => {
  try {
    const { status, prizeInfo, description } = req.body as any;
    const league = await prisma.league.findUnique({ where: { id: req.params.id } });
    if (!league) return next(new AppError("League not found.", 404));

    if (status && !["UPCOMING", "ACTIVE", "COMPLETED"].includes(status)) {
      return next(new AppError("Invalid status.", 400));
    }

    const updated = await prisma.league.update({
      where: { id: league.id },
      data: {
        ...(status ? { status: status as any } : {}),
        ...(prizeInfo !== undefined ? { prizeInfo } : {}),
        ...(description !== undefined ? { description } : {}),
      },
    });

    res.json({ message: "League updated.", league: updated });
  } catch (e) {
    next(e);
  }
});

// Manually trigger a score sync (useful for testing)
adminRouter.post("/sync", async (_req, res, next) => {
  try {
    const { fplService } = await import("../services/fpl");
    const gw = await fplService.getCurrentGameweek();
    res.json({ message: `Current GW: ${gw}. Sync will run on next cron tick.` });
  } catch (e) { next(e); }
});
