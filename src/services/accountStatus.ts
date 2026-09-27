/**
 * Account standing, checked on every authenticated request.
 *
 * The problem this solves: tokens last 30 days. Without a check on each request,
 * suspending somebody would do nothing until their token expired — they would
 * carry on playing for up to a month. So the check has to happen per request.
 *
 * The cost of that is one database read per request, which is why there is a
 * short-lived cache in front of it. The cache is 30 seconds, and the admin
 * routes call forget() the moment they change a status, so a suspension takes
 * effect immediately rather than within 30 seconds. The TTL exists only to catch
 * changes made outside the routes — a hand-edited row, a second instance.
 *
 * The bias throughout is towards letting people in. If the lookup fails, or the
 * status column is somehow missing, the request proceeds. A bug here should
 * never lock out the whole user base; the worst acceptable failure is that a
 * suspension is slow to bite.
 */
import { prisma } from "../utils/prisma";

/**
 * Deliberately one flat shape rather than a discriminated union.
 *
 * A union of { ok: true } and { ok: false, message, httpStatus } reads better,
 * but this project compiles with "strict": false, and without strictNullChecks
 * TypeScript will not narrow a union on a boolean discriminant. Every call site
 * would then fail to see `message`. One optional-field shape works under either
 * setting, so it is the right choice here even though it is the uglier type.
 */
export interface AccountStanding {
  ok: boolean;
  status?: string;
  message?: string;
  httpStatus?: number;
}

/** What to say and return when a standing has no message of its own. */
export const DEFAULT_REFUSAL = "This Clashd account is not active.";
export const DEFAULT_REFUSAL_STATUS = 403;

interface Cached {
  status: string;
  reason: string | null;
  suspendedUntil: Date | null;
  at: number;
}

const TTL_MS = 30_000;
const cache = new Map<string, Cached>();

/** Drop a user's cached standing. Called by the admin routes after a change. */
export function forgetAccountStatus(userId: string): void {
  cache.delete(userId);
}

/** Drop everything. Used by tests. */
export function forgetAllAccountStatus(): void {
  cache.clear();
}

/**
 * The message a turned-away person sees. Deliberately plain: it says what has
 * happened and what to do about it, and it does not editorialise.
 */
function messageFor(status: string, reason: string | null, until: Date | null): string {
  const because = reason ? ` Reason given: ${reason}` : "";
  switch (status) {
    case "SUSPENDED": {
      const when = until
        ? ` until ${until.toISOString().slice(0, 10)}`
        : "";
      return `Your Clashd account is suspended${when}.${because} Email admin@solvvspace.com if you think this is wrong.`;
    }
    case "BLOCKED":
      return `Your Clashd account has been closed.${because} Email admin@solvvspace.com if you think this is wrong.`;
    case "DELETED":
      return "This Clashd account has been deleted.";
    default:
      return "This Clashd account is not active.";
  }
}

async function load(userId: string): Promise<Cached | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { status: true, statusReason: true, suspendedUntil: true },
  });
  if (!user) return null;
  const row: Cached = {
    status: String(user.status ?? "ACTIVE"),
    reason: user.statusReason ?? null,
    suspendedUntil: user.suspendedUntil ?? null,
    at: Date.now(),
  };
  cache.set(userId, row);
  return row;
}

/**
 * Whether this account may act. Called by the authenticate middleware, and again
 * by the login route before a token is handed out.
 */
export async function checkAccountStanding(userId: string): Promise<AccountStanding> {
  try {
    let row = cache.get(userId);
    if (!row || Date.now() - row.at > TTL_MS) {
      row = (await load(userId)) ?? undefined;
    }

    // No row: either the account is gone or the read failed. Either way this is
    // not the place to decide — let the route's own lookup return its 404.
    if (!row) return { ok: true };

    if (row.status === "ACTIVE") return { ok: true };

    // A suspension with a date in the past has served its time. Lift it lazily
    // rather than running a job for it, and clear the cache so the next request
    // reads the updated row.
    if (
      row.status === "SUSPENDED" &&
      row.suspendedUntil &&
      row.suspendedUntil.getTime() <= Date.now()
    ) {
      await prisma.user.update({
        where: { id: userId },
        data: {
          status: "ACTIVE",
          statusReason: null,
          suspendedUntil: null,
          statusAt: new Date(),
        },
      });
      cache.delete(userId);
      return { ok: true };
    }

    return {
      ok: false,
      status: row.status,
      message: messageFor(row.status, row.reason, row.suspendedUntil),
      // 403 rather than 401: the credentials are fine, the account is not.
      // A 401 would make the app throw the person back to the login screen,
      // where they would try again and be baffled.
      httpStatus: 403,
    };
  } catch (err) {
    console.error("[accountStatus] check failed, allowing request", err);
    return { ok: true };
  }
}
