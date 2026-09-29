import { Router } from "express";
import { prisma } from "../utils/prisma";
import { authenticate } from "../middleware/authenticate";
import { requireAdmin } from "../middleware/requireAdmin";
import { AppError } from "../utils/AppError";
import { recordAdminAction, readAuditLog } from "../services/adminAudit";
import { forgetAccountStatus } from "../services/accountStatus";
import {
  softDeleteUser,
  restoreUser,
  purgeUser,
  listPurgeDue,
  isPurgeDue,
  purgeDueAt,
  RETENTION_DAYS,
} from "../services/accountLifecycle";

export const adminRouter = Router();
adminRouter.use(authenticate, requireAdmin);

/* ────────────────────────────────────────────────────────────────────────────
   Shared guards
   Three rules, applied to every action that changes what another person can do.
   They exist because the failure modes are embarrassing rather than subtle: an
   admin locking themselves out, two admins suspending each other, or the last
   admin account being disabled and nobody able to get back in.
   ──────────────────────────────────────────────────────────────────────────── */

async function loadTarget(id: string) {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw new AppError("User not found.", 404);
  return user;
}

function refuseSelf(target: { id: string }, actorId: string, verb: string) {
  if (target.id === actorId) {
    throw new AppError(`You cannot ${verb} your own account.`, 400);
  }
}

function refuseAdmin(target: { role: string; displayName: string }) {
  if (target.role === "ADMIN") {
    throw new AppError(
      `${target.displayName} is an admin. Remove their admin access first, then try again.`,
      403
    );
  }
}

function requireReason(reason: unknown, action: string): string {
  const text = typeof reason === "string" ? reason.trim() : "";
  if (text.length < 3) {
    throw new AppError(`A reason is required to ${action} an account.`, 400);
  }
  return text.slice(0, 500);
}

/** What the client is allowed to see of another user. */
const USER_LIST_FIELDS = {
  id: true,
  email: true,
  displayName: true,
  role: true,
  status: true,
  statusReason: true,
  statusAt: true,
  suspendedUntil: true,
  deletedAt: true,
  fplTeamId: true,
  fplTeamName: true,
  totalPoints: true,
  platformRank: true,
  proUntil: true,
  proSource: true,
  createdAt: true,
  _count: { select: { entries: true } },
} as const;

/* ────────────────────────────────────────────────────────────────────────────
   Overview
   ──────────────────────────────────────────────────────────────────────────── */

adminRouter.get("/stats", async (_req, res, next) => {
  try {
    const [users, leagues, entries, syncs, linked, byStatus, pro] = await Promise.all([
      prisma.user.count(),
      prisma.league.count(),
      prisma.entry.count(),
      prisma.fplSync.findMany({ orderBy: { syncedAt: "desc" }, take: 10 }),
      prisma.user.count({ where: { fplTeamId: { not: null } } }),
      prisma.user.groupBy({ by: ["status"], _count: { _all: true } }),
      prisma.user.count({ where: { proUntil: { gt: new Date() } } }),
    ]);

    // Flattened into an object so the client does not have to hunt the array.
    const status: Record<string, number> = {
      ACTIVE: 0, SUSPENDED: 0, BLOCKED: 0, DELETED: 0,
    };
    for (const row of byStatus) status[String(row.status)] = row._count._all;

    res.json({ users, linked, leagues, entries, pro, status, recentSyncs: syncs });
  } catch (e) { next(e); }
});

/* ────────────────────────────────────────────────────────────────────────────
   Users
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * A page of users, searchable and filterable.
 *
 * The old version of this returned every user with no limit. That is fine with
 * six accounts and a problem with six thousand, and the fix is cheaper now than
 * after launch.
 *
 * Soft-deleted accounts are hidden unless asked for. An admin looking at "the
 * users" means the live ones.
 *
 * TWO RESPONSE SHAPES, on purpose.
 *
 * This endpoint used to return a bare array, and the iOS app already in people's
 * hands iterates exactly that. Changing it to a paginated object broke the app's
 * Admin panel outright — it cannot be fixed by changing the client, because the
 * client is already installed on phones.
 *
 * So: a caller that asks for a page gets the paginated object, and a caller that
 * asks for nothing gets the old array. The web Admin tab always sends `page`, so
 * it always gets the object. The shipped app sends nothing and keeps working.
 *
 * This asymmetry is a wart. It stays until no build in the wild calls the bare
 * endpoint, and then the array branch can go.
 */
adminRouter.get("/users", async (req: any, res, next) => {
  try {
    const wantsPage = req.query.page !== undefined || req.query.perPage !== undefined;
    const perPage = Math.min(Math.max(parseInt(String(req.query.perPage ?? 50), 10) || 50, 1), 200);
    const page = Math.max(parseInt(String(req.query.page ?? 1), 10) || 1, 1);
    const q = String(req.query.q ?? "").trim();
    const status = String(req.query.status ?? "").trim().toUpperCase();
    const role = String(req.query.role ?? "").trim().toUpperCase();

    const where: any = {};

    if (status && ["ACTIVE", "SUSPENDED", "BLOCKED", "DELETED"].includes(status)) {
      where.status = status;
    } else if (!status || status === "LIVE") {
      where.status = { not: "DELETED" };
    }
    // status=ALL falls through with no status filter at all.
    if (status === "ALL") delete where.status;

    if (role && ["PLAYER", "ADMIN"].includes(role)) where.role = role;

    if (q) {
      where.OR = [
        { email: { contains: q, mode: "insensitive" } },
        { displayName: { contains: q, mode: "insensitive" } },
        { fplTeamName: { contains: q, mode: "insensitive" } },
        ...(/^\d+$/.test(q) ? [{ fplTeamId: Number(q) }] : []),
      ];
    }

    const [rows, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: USER_LIST_FIELDS as any,
        orderBy: { createdAt: "desc" },
        // The legacy caller gets everything, capped so a large account list can
        // never become an unbounded response.
        skip: wantsPage ? (page - 1) * perPage : 0,
        take: wantsPage ? perPage : 500,
      }),
      prisma.user.count({ where }),
    ]);

    if (!wantsPage) return res.json(rows);

    res.json({
      rows,
      page,
      perPage,
      total,
      pages: Math.max(1, Math.ceil(total / perPage)),
    });
  } catch (e) { next(e); }
});

/**
 * One account in full, with its leagues and its own admin history. This is what
 * an admin reads before deciding to suspend somebody, so it includes the private
 * note and the audit trail.
 */
adminRouter.get("/users/:id", async (req: any, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      // Written out rather than spread from USER_LIST_FIELDS. Spreading it
      // through `as any` made Prisma give up on inferring the result type, and
      // every property read off the result then resolved to the wrong thing.
      select: {
        id: true,
        email: true,
        displayName: true,
        role: true,
        status: true,
        statusReason: true,
        statusAt: true,
        suspendedUntil: true,
        deletedAt: true,
        fplTeamId: true,
        fplTeamName: true,
        totalPoints: true,
        platformRank: true,
        proUntil: true,
        proSource: true,
        createdAt: true,
        statusNote: true,
        statusById: true,
        priorDisplayName: true,
        proProductId: true,
        proWillRenew: true,
        _count: { select: { entries: true } },
        entries: {
          select: {
            id: true,
            totalPoints: true,
            currentRank: true,
            joinedAt: true,
            league: { select: { id: true, name: true, status: true, format: true } },
          },
          orderBy: { joinedAt: "desc" },
        },
      },
    });
    if (!user) throw new AppError("User not found.", 404);

    const [history, statusBy] = await Promise.all([
      readAuditLog({ targetId: req.params.id, perPage: 50 }),
      // Who last changed this account's standing, resolved to a name.
      user.statusById
        ? prisma.user.findUnique({
            where: { id: user.statusById },
            select: { id: true, displayName: true, email: true },
          })
        : Promise.resolve(null),
    ]);

    res.json({
      user,
      statusBy,
      purgeDueAt: user.deletedAt ? purgeDueAt(user.deletedAt) : null,
      purgeDue: isPurgeDue(user.deletedAt),
      retentionDays: RETENTION_DAYS,
      history: history.rows,
    });
  } catch (e) { next(e); }
});

/**
 * Change an account's standing.
 *
 * One endpoint rather than four, because suspend, block and delete are the same
 * decision at different severities and splitting them invites the four code
 * paths to drift apart.
 */
adminRouter.patch("/users/:id/status", async (req: any, res, next) => {
  try {
    const { status, reason, note, until } = req.body as {
      status?: string; reason?: string; note?: string; until?: string;
    };

    const wanted = String(status ?? "").trim().toUpperCase();
    if (!["ACTIVE", "SUSPENDED", "BLOCKED", "DELETED"].includes(wanted)) {
      throw new AppError("Status must be ACTIVE, SUSPENDED, BLOCKED or DELETED.", 400);
    }

    const target = await loadTarget(req.params.id);

    if (wanted !== "ACTIVE") {
      refuseSelf(target, req.userId, "suspend, block or delete");
      refuseAdmin(target);
    }

    const before = {
      status: target.status,
      statusReason: target.statusReason,
      suspendedUntil: target.suspendedUntil,
    };

    /* ── back to active ── */
    if (wanted === "ACTIVE") {
      const done = await restoreUser({
        userId: target.id,
        actorId: req.userId,
        reason: reason ?? null,
      });
      await recordAdminAction({
        actorId: req.userId,
        action: target.status === "DELETED" ? "RESTORE"
              : target.status === "BLOCKED" ? "UNBLOCK" : "UNSUSPEND",
        targetType: "USER",
        targetId: target.id,
        targetLabel: `${target.priorDisplayName ?? target.displayName} (${target.email})`,
        reason: reason ?? null,
        meta: { before, after: { status: "ACTIVE" } },
      });
      return res.json({
        message: `${done?.updated.displayName} is active again.`,
        user: done?.updated,
        note: done?.purged
          ? "This account was already purged, so its email and name could not be restored."
          : undefined,
      });
    }

    /* ── suspended ── */
    if (wanted === "SUSPENDED") {
      const why = requireReason(reason, "suspend");

      let untilDate: Date | null = null;
      if (until) {
        untilDate = new Date(until);
        if (isNaN(untilDate.getTime())) throw new AppError("That end date is not valid.", 400);
        if (untilDate.getTime() <= Date.now()) {
          throw new AppError("A suspension end date has to be in the future.", 400);
        }
      }

      const updated = await prisma.user.update({
        where: { id: target.id },
        data: {
          status: "SUSPENDED",
          statusReason: why,
          statusNote: note ? String(note).slice(0, 1000) : null,
          statusAt: new Date(),
          statusById: req.userId,
          suspendedUntil: untilDate,
          deletedAt: null,
        },
      });
      forgetAccountStatus(target.id);

      await recordAdminAction({
        actorId: req.userId,
        action: "SUSPEND",
        targetType: "USER",
        targetId: target.id,
        targetLabel: `${target.displayName} (${target.email})`,
        reason: why,
        meta: { before, after: { status: "SUSPENDED", suspendedUntil: untilDate } },
      });

      return res.json({
        message: untilDate
          ? `${updated.displayName} is suspended until ${untilDate.toISOString().slice(0, 10)}.`
          : `${updated.displayName} is suspended.`,
        user: updated,
      });
    }

    /* ── blocked ── */
    if (wanted === "BLOCKED") {
      const why = requireReason(reason, "block");

      const updated = await prisma.user.update({
        where: { id: target.id },
        data: {
          status: "BLOCKED",
          statusReason: why,
          statusNote: note ? String(note).slice(0, 1000) : null,
          statusAt: new Date(),
          statusById: req.userId,
          suspendedUntil: null,
          deletedAt: null,
        },
      });
      forgetAccountStatus(target.id);

      await recordAdminAction({
        actorId: req.userId,
        action: "BLOCK",
        targetType: "USER",
        targetId: target.id,
        targetLabel: `${target.displayName} (${target.email})`,
        reason: why,
        meta: { before, after: { status: "BLOCKED" } },
      });

      return res.json({
        message: `${updated.displayName} is blocked. That email cannot register again.`,
        user: updated,
      });
    }

    /* ── deleted (soft) ── */
    const why = requireReason(reason, "delete");
    const done = await softDeleteUser({
      userId: target.id,
      actorId: req.userId,
      reason: why,
      note: note ? String(note).slice(0, 1000) : null,
    });

    await recordAdminAction({
      actorId: req.userId,
      action: "DELETE",
      targetType: "USER",
      targetId: target.id,
      targetLabel: `${target.displayName} (${target.email})`,
      reason: why,
      meta: {
        before,
        after: { status: "DELETED" },
        priorDisplayName: done?.priorDisplayName,
        retentionDays: RETENTION_DAYS,
      },
    });

    return res.json({
      message:
        `${done?.priorDisplayName} is deleted and now shows as "Former manager". ` +
        `Their league results are untouched. Identifying details are removed after ${RETENTION_DAYS} days, ` +
        `and it can be undone until then.`,
      user: done?.updated,
    });
  } catch (e) { next(e); }
});

/**
 * Kept as a convenience because a DELETE verb on a user is what any admin UI
 * reaches for first. It is a soft delete — the same code path as above — so
 * there is no way to reach the old destructive behaviour by accident.
 */
adminRouter.delete("/users/:id", async (req: any, res, next) => {
  try {
    // The web Admin tab always sends a reason and refuses to submit without one.
    // The iOS app already in people's hands does not, and refusing it here would
    // break a button that works today. So the reason is recorded either way, and
    // its absence is recorded honestly rather than the delete being blocked.
    const given = typeof req.body?.reason === "string" ? req.body.reason.trim()
                : typeof req.query?.reason === "string" ? String(req.query.reason).trim()
                : "";
    const why = given ? given.slice(0, 500) : "No reason given (deleted from the app).";
    const target = await loadTarget(req.params.id);
    refuseSelf(target, req.userId, "delete");
    refuseAdmin(target);

    const done = await softDeleteUser({
      userId: target.id,
      actorId: req.userId,
      reason: why,
      note: req.body?.note ?? null,
    });

    await recordAdminAction({
      actorId: req.userId,
      action: "DELETE",
      targetType: "USER",
      targetId: target.id,
      targetLabel: `${target.displayName} (${target.email})`,
      reason: why,
      meta: { priorDisplayName: done?.priorDisplayName, retentionDays: RETENTION_DAYS },
    });

    res.json({
      message: `${done?.priorDisplayName} is deleted. Undo is available for ${RETENTION_DAYS} days.`,
      id: target.id,
      user: done?.updated,
    });
  } catch (e) { next(e); }
});

/** Accounts whose retention window has expired and are waiting to be purged. */
adminRouter.get("/users/purge/due", async (_req, res, next) => {
  try {
    const rows = await listPurgeDue();
    res.json({ rows, retentionDays: RETENTION_DAYS });
  } catch (e) { next(e); }
});

/**
 * Overwrite the identifying fields. This is the irreversible one, so it refuses
 * unless the account is already soft-deleted, and it refuses to jump the
 * retention window unless the caller says so explicitly — an erasure request
 * from the person themselves being the case that justifies it.
 */
adminRouter.post("/users/:id/purge", async (req: any, res, next) => {
  try {
    const why = requireReason(req.body?.reason, "purge");
    const target = await loadTarget(req.params.id);
    refuseSelf(target, req.userId, "purge");

    if (target.status !== "DELETED") {
      throw new AppError("Delete the account first. Purge only finishes a deletion.", 400);
    }
    if (!isPurgeDue(target.deletedAt) && req.body?.early !== true) {
      const when = target.deletedAt ? purgeDueAt(target.deletedAt).toISOString().slice(0, 10) : "unknown";
      throw new AppError(
        `This account is not due for purge until ${when}. Send early: true to purge now.`,
        400
      );
    }

    const done = await purgeUser({ userId: target.id, actorId: req.userId });

    await recordAdminAction({
      actorId: req.userId,
      action: "PURGE",
      targetType: "USER",
      targetId: target.id,
      // The email is recorded here because this is the last moment it exists,
      // and an erasure has to be provable afterwards.
      targetLabel: `${target.priorDisplayName ?? target.displayName} (${done?.previousEmail})`,
      reason: why,
      meta: { early: req.body?.early === true, deletedAt: target.deletedAt },
    });

    res.json({
      message: "Identifying details removed. League results are unchanged.",
      user: done?.updated,
    });
  } catch (e) { next(e); }
});

/* ── Promote an existing user to admin, or demote back to player ───────────── */
adminRouter.patch("/users/:id/role", async (req: any, res, next) => {
  try {
    const { role, reason } = req.body as { role: string; reason?: string };
    if (!["ADMIN", "PLAYER"].includes(role)) {
      throw new AppError("Role must be ADMIN or PLAYER.", 400);
    }

    const target = await loadTarget(req.params.id);

    if (target.id === req.userId && role === "PLAYER") {
      throw new AppError("You cannot remove your own admin access.", 400);
    }
    if (role === "ADMIN" && target.status !== "ACTIVE") {
      throw new AppError("Only an active account can be made an admin.", 400);
    }

    // Never allow the last admin to be demoted.
    if (target.role === "ADMIN" && role === "PLAYER") {
      const adminCount = await prisma.user.count({
        where: { role: "ADMIN", status: "ACTIVE" },
      });
      if (adminCount <= 1) throw new AppError("There must be at least one admin.", 400);
    }

    const updated = await prisma.user.update({
      where: { id: target.id },
      data: { role: role as any },
      select: { id: true, email: true, displayName: true, role: true },
    });

    await recordAdminAction({
      actorId: req.userId,
      action: role === "ADMIN" ? "ROLE_GRANT" : "ROLE_REVOKE",
      targetType: "USER",
      targetId: target.id,
      targetLabel: `${target.displayName} (${target.email})`,
      reason: reason ?? null,
      meta: { before: target.role, after: role },
    });

    res.json({
      message: role === "ADMIN"
        ? `${updated.displayName} is now an admin.`
        : `${updated.displayName} is now a player.`,
      user: updated,
    });
  } catch (e) { next(e); }
});

/* ────────────────────────────────────────────────────────────────────────────
   Audit log
   Read only. There is deliberately no route that edits or removes a row.
   ──────────────────────────────────────────────────────────────────────────── */

adminRouter.get("/audit", async (req: any, res, next) => {
  try {
    const out = await readAuditLog({
      page: parseInt(String(req.query.page ?? 1), 10) || 1,
      perPage: parseInt(String(req.query.perPage ?? 50), 10) || 50,
      action: req.query.action ? (String(req.query.action).toUpperCase() as any) : undefined,
      targetId: req.query.targetId ? String(req.query.targetId) : undefined,
    });
    res.json(out);
  } catch (e) { next(e); }
});

/* ────────────────────────────────────────────────────────────────────────────
   Leagues
   ──────────────────────────────────────────────────────────────────────────── */

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
      name, inviteCode, format, description, prizeInfo,
      startGameweek, endGameweek, payingPlaces, season, formationSpec,
    } = req.body as any;

    if (!name || !String(name).trim()) throw new AppError("League name is required.", 400);
    if (!format || !VALID_FORMATS.includes(format)) {
      throw new AppError("Choose a valid league format.", 400);
    }

    const start = parseInt(String(startGameweek ?? 1), 10);
    const end = parseInt(String(endGameweek ?? 38), 10);
    if (isNaN(start) || isNaN(end) || start < 1 || end > 38 || start > end) {
      throw new AppError("Gameweek range must be between 1 and 38.", 400);
    }

    const places = parseInt(String(payingPlaces ?? 1), 10);
    if (isNaN(places) || places < 1 || places > 20) {
      throw new AppError("Paying places must be between 1 and 20.", 400);
    }

    let code = (inviteCode ? String(inviteCode) : "").trim().toUpperCase();
    if (!code) code = "ARENA-" + Math.random().toString(36).substring(2, 8).toUpperCase();
    if (!/^[A-Z0-9-]{4,24}$/.test(code)) {
      throw new AppError("Invite code must be 4-24 letters, numbers or dashes.", 400);
    }
    const clash = await prisma.league.findUnique({ where: { inviteCode: code } });
    if (clash) throw new AppError("That invite code is already in use.", 400);

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

    await recordAdminAction({
      actorId: req.userId,
      action: "LEAGUE_CREATE",
      targetType: "LEAGUE",
      targetId: league.id,
      targetLabel: `${league.name} (${league.inviteCode})`,
      meta: { format: league.format, start, end, payingPlaces: places },
    });

    res.status(201).json({ message: `League "${league.name}" created.`, league });
  } catch (e) { next(e); }
});

adminRouter.patch("/leagues/:id", async (req: any, res, next) => {
  try {
    const { status, prizeInfo, description, name } = req.body as any;
    const league = await prisma.league.findUnique({ where: { id: req.params.id } });
    if (!league) throw new AppError("League not found.", 404);

    if (status && !["UPCOMING", "ACTIVE", "COMPLETED"].includes(status)) {
      throw new AppError("Invalid status.", 400);
    }

    const updated = await prisma.league.update({
      where: { id: league.id },
      data: {
        ...(status ? { status: status as any } : {}),
        ...(prizeInfo !== undefined ? { prizeInfo } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(name && String(name).trim() ? { name: String(name).trim().slice(0, 80) } : {}),
      },
    });

    await recordAdminAction({
      actorId: req.userId,
      action: "LEAGUE_UPDATE",
      targetType: "LEAGUE",
      targetId: league.id,
      targetLabel: `${updated.name} (${updated.inviteCode})`,
      meta: {
        before: { status: league.status, name: league.name },
        after: { status: updated.status, name: updated.name },
      },
    });

    res.json({ message: "League updated.", league: updated });
  } catch (e) { next(e); }
});

/* Trigger a real score sync now rather than waiting for the next cron tick. */
adminRouter.post("/sync", async (req: any, res, next) => {
  try {
    const { syncScores } = await import("../jobs/fplSync");
    const { fplService } = await import("../services/fpl");
    const gw = await fplService.getCurrentGameweek();
    await syncScores();

    await recordAdminAction({
      actorId: req.userId,
      action: "SYNC",
      targetType: "SYSTEM",
      targetLabel: `Manual score sync, GW${gw}`,
      meta: { gameweek: gw },
    });

    res.json({ message: `Sync complete for GW${gw}.` });
  } catch (e) { next(e); }
});
