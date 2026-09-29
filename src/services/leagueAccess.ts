/**
 * Who is paying for an imported competition, and what happens when nobody is.
 *
 * Clashd's own competitions are free forever and never pass through here. This
 * file is only about imported FPL mini-leagues, which cost real money to run
 * because every manager in them is synced from FPL every gameweek.
 *
 * The shape of the deal, and the reasoning behind each part:
 *
 *   TRIAL     Two gameweeks from the group's start, free. Long enough for a
 *             group to see their table move and decide it is worth paying for.
 *             Anything shorter asks people to pay for something they have not
 *             yet seen work.
 *
 *   PAID      A verified Club pass covers the whole suite for the season.
 *
 *   FROZEN    Scoring stops. The table stays exactly as it was at the last
 *             completed gameweek, visible to everyone, with a notice saying
 *             what happened and what restarts it. Nothing is taken away; it
 *             simply stops moving. Hiding a table people could already see
 *             reads as punishment, and punishing members for something the
 *             group did not buy is the wrong instinct.
 *
 *   ARCHIVED  After fourteen further days, the suite disappears from members'
 *             views. The rows survive so an admin can reverse it and so nobody
 *             else's history is disturbed.
 *
 * Paying restarts the suite AND backfills the gameweeks it missed, so the table
 * is correct rather than having a hole in it. A competition with missing
 * gameweeks is worse than one that paused honestly.
 *
 * Every decision here is made server-side. The client is told what the state is
 * so it can explain it; it never gets to assert it.
 */
import { prisma } from "../utils/prisma";
import { clubBandFor } from "./entitlements";

/** Gameweeks an imported suite runs free before it needs a pass. */
export const TRIAL_GAMEWEEKS = 2;

/** Days a frozen suite waits before it is archived. */
export const GRACE_DAYS = 14;

export type AccessState = "FREE" | "TRIAL" | "PAID" | "FROZEN" | "ARCHIVED";

/** The group key for an imported suite. One FPL league, one group. */
export function groupIdFor(fplLeagueId: number): string {
  return `fpl:${fplLeagueId}`;
}

/** Every competition in a suite. */
export function suiteOf(importGroupId: string) {
  return prisma.league.findMany({
    where: { importGroupId },
    orderBy: { inviteCode: "asc" },
  });
}

/**
 * How many distinct managers are in a suite.
 *
 * Counted across the whole group rather than one competition, because a member
 * is in all nine and seats are sold per person, not per table. Pending members
 * (managers in the FPL league who have not joined Clashd) are counted too: the
 * group is buying cover for its whole membership, and a seat that fills next
 * week should not push them over the band mid-season.
 */
export async function seatCountFor(importGroupId: string): Promise<{
  members: number;
  pending: number;
  total: number;
}> {
  const leagues = await prisma.league.findMany({
    where: { importGroupId },
    select: { id: true },
  });
  const ids = leagues.map((l) => l.id);
  if (!ids.length) return { members: 0, pending: 0, total: 0 };

  const [entries, pending] = await Promise.all([
    prisma.entry.findMany({
      where: { leagueId: { in: ids } },
      select: { userId: true },
      distinct: ["userId"],
    }),
    prisma.pendingMember.findMany({
      where: { leagueId: { in: ids } },
      select: { fplTeamId: true },
      distinct: ["fplTeamId"],
    }),
  ]);

  return {
    members: entries.length,
    pending: pending.length,
    total: entries.length + pending.length,
  };
}

/** The verified Club pass covering a suite this season, if there is one. */
export async function passFor(importGroupId: string, season: string) {
  const leagues = await prisma.league.findMany({
    where: { importGroupId },
    select: { id: true },
  });
  const ids = leagues.map((l) => l.id);
  if (!ids.length) return null;

  return prisma.clubPass.findFirst({
    where: {
      leagueId: { in: ids },
      season,
      verified: true,
      cancelledAt: null,
      activeUntil: { gt: new Date() },
    },
    orderBy: { activeUntil: "desc" },
  });
}

/**
 * Everything a client needs to explain this suite's situation to its members,
 * in one object. Deliberately verbose: the alternative is the app inferring
 * state from a status code, which is how clients and servers drift apart.
 */
export async function accessSummary(importGroupId: string) {
  const leagues = await suiteOf(importGroupId);
  if (!leagues.length) return null;

  const primary = leagues.find((l) => l.importedFromFplId != null) ?? leagues[0];
  const season = primary.season;
  const ids = leagues.map((l) => l.id);

  const [seats, pass, lastScored] = await Promise.all([
    seatCountFor(importGroupId),
    passFor(importGroupId, season),
    prisma.gwScore.findFirst({
      where: { leagueId: { in: ids } },
      orderBy: { gameweek: "desc" },
      select: { gameweek: true },
    }),
  ]);

  const band = clubBandFor(seats.total);
  const access = String(primary.access) as AccessState;

  // A pass that no longer covers the group's size. The suite keeps running:
  // people who paid should not be frozen because somebody else joined. New
  // joins are blocked instead, which is handled in canJoin().
  const outgrown = !!pass && seats.total > pass.seats;

  return {
    importGroupId,
    name: primary.name.replace(/\s+\S+$/, ""), // the group name without the suffix
    access,
    competitions: leagues.length,
    season,
    trialEndsGw: primary.trialEndsGw,
    frozenAt: primary.frozenAt,
    archiveDueAt: primary.archiveDueAt,
    lastScoredGameweek: lastScored?.gameweek ?? null,
    seats: {
      members: seats.members,
      notYetJoined: seats.pending,
      total: seats.total,
      covered: pass?.seats ?? null,
      outgrown,
    },
    pass: pass
      ? {
          productId: pass.productId,
          seats: pass.seats,
          activeUntil: pass.activeUntil,
        }
      : null,
    /** What it would cost to start or upgrade. Null past the largest band. */
    needed: band
      ? { productId: band.productId, seats: band.seats, pence: band.pence }
      : null,
  };
}

/* ── transitions ───────────────────────────────────────────────────────── */

/**
 * Freeze a whole suite at once.
 *
 * Atomic across the group because a half-frozen suite is incoherent: members
 * would see three of their nine tables updating and no explanation for the rest.
 */
export async function freezeGroup(importGroupId: string) {
  const now = new Date();
  const archiveDueAt = new Date(now.getTime() + GRACE_DAYS * 86_400_000);

  const res = await prisma.league.updateMany({
    where: { importGroupId, access: { in: ["TRIAL", "PAID"] } },
    data: { access: "FROZEN", frozenAt: now, archiveDueAt },
  });

  if (res.count) await notifySuite(importGroupId, "frozen", archiveDueAt);
  return { frozen: res.count, archiveDueAt };
}

/**
 * Restart a suite. Called when a Club pass is verified, or by an admin.
 *
 * Returns the gameweeks that were missed while frozen, so the caller can
 * backfill them. It does not backfill here: recomputing scores is the sync
 * job's work, and this file should not be reaching into it.
 */
export async function unfreezeGroup(importGroupId: string, currentGameweek: number) {
  const leagues = await suiteOf(importGroupId);
  if (!leagues.length) return null;

  const ids = leagues.map((l) => l.id);
  const lastScored = await prisma.gwScore.findFirst({
    where: { leagueId: { in: ids } },
    orderBy: { gameweek: "desc" },
    select: { gameweek: true },
  });

  await prisma.league.updateMany({
    where: { importGroupId },
    data: { access: "PAID", frozenAt: null, archiveDueAt: null, archivedAt: null },
  });

  // Every gameweek between the last one scored and now, inclusive of neither
  // end being assumed: if nothing was ever scored there is nothing to catch up.
  const missed: number[] = [];
  if (lastScored) {
    for (let gw = lastScored.gameweek + 1; gw <= currentGameweek; gw++) missed.push(gw);
  }

  await notifySuite(importGroupId, "restarted");
  return { leagues: leagues.length, missedGameweeks: missed };
}

/** Hide a suite whose grace period has run out. Reversible by an admin. */
export async function archiveGroup(importGroupId: string) {
  const res = await prisma.league.updateMany({
    where: { importGroupId, access: "FROZEN" },
    data: { access: "ARCHIVED", archivedAt: new Date() },
  });
  return { archived: res.count };
}

/* ── the scheduled part ────────────────────────────────────────────────── */

/**
 * Freeze suites whose free window has passed with no pass, and archive frozen
 * suites past their grace period. Run from the sync job, so it happens on the
 * same clock as scoring rather than on a timer of its own.
 */
export async function enforceAccess(currentGameweek: number) {
  const out = { frozen: 0, archived: 0 };

  // 1. Trials that have run out.
  const trials = await prisma.league.findMany({
    where: {
      access: "TRIAL",
      importGroupId: { not: null },
      trialEndsGw: { lt: currentGameweek },
    },
    select: { importGroupId: true, season: true },
    distinct: ["importGroupId"],
  });

  for (const t of trials) {
    if (!t.importGroupId) continue;
    // Somebody may have paid between the trial ending and this running.
    const pass = await passFor(t.importGroupId, t.season);
    if (pass) {
      await prisma.league.updateMany({
        where: { importGroupId: t.importGroupId },
        data: { access: "PAID" },
      });
      continue;
    }
    const r = await freezeGroup(t.importGroupId);
    out.frozen += r.frozen;
  }

  // 2. Paid suites whose pass has expired.
  const paid = await prisma.league.findMany({
    where: { access: "PAID", importGroupId: { not: null } },
    select: { importGroupId: true, season: true },
    distinct: ["importGroupId"],
  });
  for (const p of paid) {
    if (!p.importGroupId) continue;
    const pass = await passFor(p.importGroupId, p.season);
    if (!pass) {
      const r = await freezeGroup(p.importGroupId);
      out.frozen += r.frozen;
    }
  }

  // 3. Frozen suites past their grace period.
  const due = await prisma.league.findMany({
    where: {
      access: "FROZEN",
      importGroupId: { not: null },
      archiveDueAt: { lte: new Date() },
    },
    select: { importGroupId: true },
    distinct: ["importGroupId"],
  });
  for (const d of due) {
    if (!d.importGroupId) continue;
    const r = await archiveGroup(d.importGroupId);
    out.archived += r.archived;
  }

  return out;
}

/* ── joining ───────────────────────────────────────────────────────────── */

/**
 * Whether somebody may join this suite right now.
 *
 * A league that has outgrown its pass refuses new members rather than letting
 * them in un-scored or freezing everyone. The people who already paid keep
 * playing; the person at the door gets told plainly what is needed. Every other
 * option leaves somebody in a state they cannot understand from the screen.
 */
export async function canJoin(importGroupId: string): Promise<{
  ok: boolean;
  reason?: string;
}> {
  const leagues = await suiteOf(importGroupId);
  if (!leagues.length) return { ok: true };

  const primary = leagues.find((l) => l.importedFromFplId != null) ?? leagues[0];
  const access = String(primary.access);

  if (access === "ARCHIVED") {
    return { ok: false, reason: "This group is no longer running on Clashd." };
  }
  if (access === "FROZEN") {
    return {
      ok: false,
      reason: "This group is paused until someone buys a Club pass for it.",
    };
  }

  const pass = await passFor(importGroupId, primary.season);
  if (pass) {
    const seats = await seatCountFor(importGroupId);
    if (seats.total >= pass.seats) {
      return {
        ok: false,
        reason: `This group's Club pass covers ${pass.seats} managers and is full. Someone in the group needs to upgrade it before anyone else can join.`,
      };
    }
  }

  return { ok: true };
}

/* ── telling people ────────────────────────────────────────────────────── */

/**
 * Notify every member of a suite. Deliberately one notification per person
 * rather than one per competition: nine identical alerts for the same event is
 * how an app gets its notifications turned off.
 */
async function notifySuite(
  importGroupId: string,
  kind: "frozen" | "restarted" | "ending",
  archiveDueAt?: Date
) {
  const leagues = await prisma.league.findMany({
    where: { importGroupId },
    select: { id: true, name: true },
  });
  if (!leagues.length) return;

  const members = await prisma.entry.findMany({
    where: { leagueId: { in: leagues.map((l) => l.id) } },
    select: { userId: true },
    distinct: ["userId"],
  });
  if (!members.length) return;

  const groupName = leagues[0].name.replace(/\s+\S+$/, "");

  const copy = {
    frozen: {
      title: "Your league is paused",
      body:
        `${groupName} has stopped updating because its free period ended. ` +
        `A Club pass restarts it and fills in the gameweeks it missed` +
        (archiveDueAt
          ? `. It will be removed on ${archiveDueAt.toISOString().slice(0, 10)} if nobody buys one.`
          : "."),
    },
    restarted: {
      title: "Your league is back",
      body: `${groupName} is running again, and the gameweeks it missed are being filled in.`,
    },
    ending: {
      title: "Your league's free period is ending",
      body: `${groupName} stops updating after this gameweek unless someone buys a Club pass.`,
    },
  }[kind];

  await prisma.notification.createMany({
    data: members.map((m) => ({
      userId: m.userId,
      title: copy.title,
      body: copy.body,
      type: "league_update",
      metadata: { importGroupId } as any,
    })),
  });
}

/** Exported so the sync job can warn a group the gameweek before it freezes. */
export async function warnSuiteEnding(importGroupId: string) {
  await notifySuite(importGroupId, "ending");
}
