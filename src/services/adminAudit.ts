/**
 * The admin audit log.
 *
 * One function, called after an admin action has succeeded. It records who did
 * what to whom and why, with the actor's and target's details copied onto the
 * row rather than only referenced, so the entry still reads correctly years
 * later when either account is gone.
 *
 * Two rules this file exists to enforce:
 *
 *   1. There is no update and no delete. The log is append-only by construction,
 *      not by convention — nothing here can rewrite history, so no route can.
 *   2. A failed write never fails the action. If the log is unavailable the
 *      suspension still happens; we complain loudly to the console rather than
 *      handing the admin an error for something that already took effect.
 *
 * Rule 2 is a deliberate trade. The alternative — refusing the action when the
 * log is down — would be more defensible in a bank. Here, the action is usually
 * someone stopping abuse, and blocking that because a log table is unreachable
 * is the worse failure.
 */
import { AdminActionType } from "@prisma/client";
import { prisma } from "../utils/prisma";

export type AuditTargetType = "USER" | "LEAGUE" | "SYSTEM";

interface RecordArgs {
  /** The admin performing the action. */
  actorId: string;
  action: AdminActionType;
  targetType: AuditTargetType;
  /** Null for SYSTEM-wide actions such as a manual sync. */
  targetId?: string | null;
  /** Human-readable identity of the target, as it was at the time. */
  targetLabel: string;
  /** What the admin typed. Required by the routes for anything punitive. */
  reason?: string | null;
  /** Before and after values, or anything else that makes the row legible. */
  meta?: Record<string, unknown> | null;
}

export async function recordAdminAction(args: RecordArgs): Promise<void> {
  try {
    // The actor is read rather than trusted from the request, so the log
    // reflects the account as the database had it, not as a token claimed.
    const actor = await prisma.user.findUnique({
      where: { id: args.actorId },
      select: { email: true, displayName: true },
    });

    await prisma.adminAuditLog.create({
      data: {
        actorId: args.actorId,
        actorEmail: actor?.email ?? "unknown",
        actorName: actor?.displayName ?? "unknown",
        action: args.action,
        targetType: args.targetType,
        targetId: args.targetId ?? null,
        targetLabel: args.targetLabel,
        reason: args.reason?.trim() || null,
        meta: (args.meta ?? undefined) as any,
      },
    });
  } catch (err) {
    // See rule 2 above.
    console.error("[audit] failed to record admin action", {
      action: args.action,
      targetId: args.targetId,
      error: err instanceof Error ? err.message : err,
    });
  }
}

/**
 * A page of the log, newest first. Filterable by action and by target so a
 * single account's history can be pulled out of a long log.
 */
export async function readAuditLog(opts: {
  page?: number;
  perPage?: number;
  action?: AdminActionType;
  targetId?: string;
}) {
  const perPage = Math.min(Math.max(opts.perPage ?? 50, 1), 200);
  const page = Math.max(opts.page ?? 1, 1);

  const where = {
    ...(opts.action ? { action: opts.action } : {}),
    ...(opts.targetId ? { targetId: opts.targetId } : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.adminAuditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    prisma.adminAuditLog.count({ where }),
  ]);

  return {
    rows,
    page,
    perPage,
    total,
    pages: Math.max(1, Math.ceil(total / perPage)),
  };
}
