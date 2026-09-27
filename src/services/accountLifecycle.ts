/**
 * Soft delete, restore and purge.
 *
 * The rule the whole file is built around: a manager's entries and gameweek
 * scores are never removed. They are part of other people's results. Delete a
 * manager who finished second in a completed league and you have not removed one
 * person's data, you have rewritten a competition that other people played in
 * and changed who came third.
 *
 * So deletion here happens to the *person*, not to the *record of play*:
 *
 *   Soft delete  The account stops working, and the display name becomes
 *                "Former manager" at once. Because every standings query already
 *                reads displayName, that single change makes every league table,
 *                fixture and analysis view correct without touching one of them.
 *                The real name is kept in priorDisplayName so a restore is exact.
 *
 *   Purge        After the retention window, the identifying fields are
 *                overwritten: email replaced with an unusable address, password
 *                hash randomised, avatar and FPL team name cleared. The entries
 *                and scores survive, now attached to nobody in particular.
 *
 * That gives a person the erasure they are entitled to without falsifying the
 * competition history of everybody else.
 */
import crypto from "crypto";
import { prisma } from "../utils/prisma";
import { forgetAccountStatus } from "./accountStatus";

/** How long a soft-deleted account waits before its identifying fields go. */
export const RETENTION_DAYS = 30;

export const FORMER_NAME = "Former manager";

export function purgeDueAt(deletedAt: Date): Date {
  return new Date(deletedAt.getTime() + RETENTION_DAYS * 86_400_000);
}

export function isPurgeDue(deletedAt: Date | null): boolean {
  if (!deletedAt) return false;
  return purgeDueAt(deletedAt).getTime() <= Date.now();
}

/**
 * Stop the account and hide the person, keeping everything needed to undo it.
 */
export async function softDeleteUser(opts: {
  userId: string;
  actorId: string;
  reason: string;
  note?: string | null;
}) {
  const user = await prisma.user.findUnique({
    where: { id: opts.userId },
    select: { displayName: true, priorDisplayName: true },
  });
  if (!user) return null;

  // Guard against a second delete overwriting the stored real name with
  // "Former manager" and losing it for good.
  const prior = user.priorDisplayName ?? user.displayName;

  const updated = await prisma.user.update({
    where: { id: opts.userId },
    data: {
      status: "DELETED",
      statusReason: opts.reason,
      statusNote: opts.note ?? null,
      statusAt: new Date(),
      statusById: opts.actorId,
      deletedAt: new Date(),
      priorDisplayName: prior,
      displayName: FORMER_NAME,
      suspendedUntil: null,
    },
  });

  forgetAccountStatus(opts.userId);
  return { updated, priorDisplayName: prior };
}

/**
 * Put an account back. Works for suspended, blocked and soft-deleted accounts;
 * it cannot bring back a purged one, because there is nothing left to bring.
 */
export async function restoreUser(opts: {
  userId: string;
  actorId: string;
  reason?: string | null;
}) {
  const user = await prisma.user.findUnique({
    where: { id: opts.userId },
    select: { status: true, priorDisplayName: true, displayName: true, email: true },
  });
  if (!user) return null;

  const purged = user.email.endsWith("@clashd.invalid");

  const updated = await prisma.user.update({
    where: { id: opts.userId },
    data: {
      status: "ACTIVE",
      statusReason: null,
      statusNote: null,
      statusAt: new Date(),
      statusById: opts.actorId,
      suspendedUntil: null,
      deletedAt: null,
      // Only rename if we actually hold a real name to put back.
      ...(user.priorDisplayName
        ? { displayName: user.priorDisplayName, priorDisplayName: null }
        : {}),
    },
  });

  forgetAccountStatus(opts.userId);
  return { updated, purged };
}

/**
 * Overwrite the identifying fields. Irreversible by design — this is the step
 * that actually satisfies an erasure request, so it has to be.
 *
 * The password hash is replaced with random bytes rather than cleared: an empty
 * hash field is the kind of thing that makes a bcrypt comparison behave in ways
 * nobody intended.
 */
export async function purgeUser(opts: { userId: string; actorId: string }) {
  const user = await prisma.user.findUnique({
    where: { id: opts.userId },
    select: { id: true, email: true, status: true, deletedAt: true },
  });
  if (!user) return null;

  const updated = await prisma.user.update({
    where: { id: opts.userId },
    data: {
      email: `deleted+${user.id}@clashd.invalid`,
      passwordHash: crypto.randomBytes(48).toString("hex"),
      displayName: FORMER_NAME,
      priorDisplayName: null,
      avatarUrl: null,
      avatarId: null,
      fplTeamName: null,
      // fplTeamId is released so the same FPL side can be linked by its real
      // owner later. It is a public FPL identifier, not personal data of ours.
      fplTeamId: null,
      fplVerifiedAt: null,
      statusNote: null,
      statusReason: "Account purged after the retention period.",
      statusAt: new Date(),
      statusById: opts.actorId,
      status: "DELETED",
    },
  });

  // Things that are purely this person's and hold no one else's results.
  await prisma.notification.deleteMany({ where: { userId: opts.userId } });
  await prisma.pushDevice.deleteMany({ where: { userId: opts.userId } });
  await prisma.squadSnapshot.deleteMany({ where: { userId: opts.userId } });

  forgetAccountStatus(opts.userId);
  return { updated, previousEmail: user.email };
}

/** Soft-deleted accounts whose retention window has run out. */
export async function listPurgeDue() {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000);
  return prisma.user.findMany({
    where: {
      status: "DELETED",
      deletedAt: { lte: cutoff },
      email: { not: { endsWith: "@clashd.invalid" } },
    },
    select: { id: true, email: true, deletedAt: true },
    orderBy: { deletedAt: "asc" },
  });
}
