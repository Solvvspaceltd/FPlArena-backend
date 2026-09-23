/**
 * Who has Clashd Analysis, and why.
 *
 * The server decides this, never the client. The app may hold a RevenueCat
 * customerInfo object, but it is only ever a hint that we should re-read;
 * every gate in the API goes through getEntitlement below.
 *
 * Four ways to hold Analysis:
 *   PREVIEW  every account, while CLASHD_FREE_PREVIEW is on (pre-launch)
 *   APPLE    an App Store subscription, monthly or yearly
 *   GOOGLE   the same through Play
 *   CLUB     somebody bought a Club pass for a league this manager is in
 *   COMP     granted by an admin (press, partners, support goodwill)
 */
import { prisma } from "../utils/prisma";

export type EntitlementSource = "PREVIEW" | "APPLE" | "GOOGLE" | "CLUB" | "COMP" | "NONE";

export interface Entitlement {
  pro: boolean;
  source: EntitlementSource;
  /** When access lapses. Null for PREVIEW and COMP with no end date. */
  until: Date | null;
  willRenew: boolean;
  productId: string | null;
  club: {
    leagueId: string;
    leagueName: string;
    season: string;
    seats: number;
    activeUntil: Date;
  } | null;
}

const NONE: Entitlement = {
  pro: false, source: "NONE", until: null, willRenew: false, productId: null, club: null,
};

/** The pre-launch switch. Set CLASHD_FREE_PREVIEW=false on Railway to start charging. */
export function freePreview(): boolean {
  return (process.env.CLASHD_FREE_PREVIEW ?? "true").toLowerCase() !== "false";
}

/* ── the product catalogue ──────────────────────────────────────────────
   These ids must match App Store Connect and Play Console exactly.        */

export const PRO_PRODUCTS: Record<string, { period: "MONTH" | "YEAR"; pence: number }> = {
  clashd_pro_monthly: { period: "MONTH", pence: 299 },
  clashd_pro_yearly:  { period: "YEAR",  pence: 2999 },
};

export const CLUB_PRODUCTS: Record<string, { seats: number; pence: number }> = {
  clashd_club_10: { seats: 10, pence: 2000 },
  clashd_club_25: { seats: 25, pence: 4500 },
  clashd_club_50: { seats: 50, pence: 8000 },
};

/** The cheapest Club band that covers a league of this size. */
export function clubBandFor(managers: number) {
  const bands = Object.entries(CLUB_PRODUCTS)
    .map(([productId, b]) => ({ productId, ...b }))
    .sort((a, b) => a.seats - b.seats);
  return bands.find((b) => managers <= b.seats) ?? null;
}

export function isProProduct(productId?: string | null) {
  return !!productId && productId in PRO_PRODUCTS;
}
export function isClubProduct(productId?: string | null) {
  return !!productId && productId in CLUB_PRODUCTS;
}

/* ── the answer ─────────────────────────────────────────────────────── */

export async function getEntitlement(userId: string): Promise<Entitlement> {
  if (freePreview()) {
    return { ...NONE, pro: true, source: "PREVIEW" };
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { proUntil: true, proSource: true, proProductId: true, proWillRenew: true },
  });
  if (!user) return { ...NONE };

  const now = new Date();

  // A subscription or a comp still in date wins: it is this manager's own.
  if (user.proUntil && user.proUntil > now && user.proSource !== "NONE" && user.proSource !== "CLUB") {
    return {
      pro: true,
      source: user.proSource as EntitlementSource,
      until: user.proUntil,
      willRenew: user.proWillRenew,
      productId: user.proProductId,
      club: null,
    };
  }
  if (user.proSource === "COMP" && !user.proUntil) {
    return { ...NONE, pro: true, source: "COMP" };
  }

  // Otherwise, is a Club pass covering them?
  const club = await coveringClubPass(userId, now);
  if (club) {
    return {
      pro: true,
      source: "CLUB",
      until: club.activeUntil,
      willRenew: false,
      productId: club.productId,
      club: {
        leagueId: club.leagueId,
        leagueName: club.leagueName,
        season: club.season,
        seats: club.seats,
        activeUntil: club.activeUntil,
      },
    };
  }

  return { ...NONE };
}

/**
 * A Club pass covers the first `seats` managers to have joined that league,
 * ordered by when they joined. Deterministic, and it never silently drops
 * somebody who was covered last week because a newcomer arrived.
 */
async function coveringClubPass(userId: string, now: Date) {
  const entries = await prisma.entry.findMany({
    where: { userId },
    select: { leagueId: true },
  });
  if (!entries.length) return null;

  const passes = await prisma.clubPass.findMany({
    where: {
      leagueId: { in: entries.map((e) => e.leagueId) },
      cancelledAt: null,
      activeUntil: { gt: now },
    },
    include: { league: { select: { name: true } } },
  });

  for (const pass of passes) {
    const covered = await prisma.entry.findMany({
      where: { leagueId: pass.leagueId },
      orderBy: { joinedAt: "asc" },
      take: pass.seats,
      select: { userId: true },
    });
    if (covered.some((e) => e.userId === userId)) {
      return {
        leagueId: pass.leagueId,
        leagueName: pass.league.name,
        season: pass.season,
        seats: pass.seats,
        activeUntil: pass.activeUntil,
        productId: pass.productId,
      };
    }
  }
  return null;
}

/** Shorthand for route handlers that only need the yes or no. */
export async function hasPro(userId: string): Promise<boolean> {
  return (await getEntitlement(userId)).pro;
}
