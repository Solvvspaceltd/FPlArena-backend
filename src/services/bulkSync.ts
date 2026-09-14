import { prisma } from "../utils/prisma";
import { fplService } from "./fpl";

/**
 * Bulk scoring.
 *
 * The original sync fetched one FPL endpoint per user, with a 250ms throttle
 * between each. That is fine for a pilot and hopeless at scale: 500 users is
 * minutes per pass, and a few thousand never completes at all. The constraint
 * was never the server — it was how many requests FPL will serve us.
 *
 * FPL's live endpoint returns EVERY player's points for a gameweek in ONE call.
 * Combined with the squad picks we already store, that lets us score every
 * Clashd manager from a handful of requests instead of one per person.
 *
 * The approach:
 *   1. One call for live player points (all ~700 players).
 *   2. One call per 50 managers for their standings, via league pages.
 *   3. Score everyone in memory.
 *
 * Picks still need a per-manager call the first time we see a gameweek, but we
 * cache them: a manager's XI does not change once the deadline passes, so it is
 * fetched once per gameweek rather than every sync pass.
 */

const PICK_CACHE_TTL_MS = 1000 * 60 * 60 * 12; // picks are fixed after deadline

type PicksRow = { element: number; multiplier: number; is_captain: boolean };

/** In-memory cache of a manager's picks for a gameweek. */
const picksCache = new Map<string, { at: number; picks: PicksRow[]; hits: number }>();

function cacheKey(teamId: number, gw: number) {
  return teamId + ":" + gw;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Score every active entry for a gameweek, using bulk data wherever possible.
 * Returns how many entries were written.
 */
export async function bulkScoreGameweek(gameweek: number) {
  // ---- 1. One call: every player's points this gameweek ----
  let livePoints: Record<number, number> = {};
  try {
    livePoints = await fplService.getLiveGwPoints(gameweek);
  } catch (e) {
    console.error("[bulkSync] live points unavailable, aborting pass", e);
    return { scored: 0, skipped: 0, reason: "live data unavailable" };
  }
  if (!livePoints || !Object.keys(livePoints).length) {
    // FPL blocks its API during live scoring windows. Writing zeros here would
    // wipe real scores, so we skip the pass entirely and try again later.
    return { scored: 0, skipped: 0, reason: "no live data yet" };
  }

  // ---- 2. Everyone we need to score ----
  const entries = await prisma.entry.findMany({
    where: {
      league: { status: "ACTIVE" },
      user: { fplTeamId: { not: null } },
    },
    include: {
      user: { select: { id: true, fplTeamId: true } },
      league: { select: { id: true, format: true, startGameweek: true, endGameweek: true } },
    },
  });
  if (!entries.length) return { scored: 0, skipped: 0 };

  // One manager can be in many leagues; only fetch their picks once.
  const uniqueTeamIds = Array.from(
    new Set(entries.map((e) => e.user.fplTeamId).filter(Boolean) as number[])
  );

  // ---- 3. Picks, cached per gameweek ----
  let fetched = 0;
  let failed = 0;
  for (const teamId of uniqueTeamIds) {
    const key = cacheKey(teamId, gameweek);
    const cached = picksCache.get(key);
    if (cached && Date.now() - cached.at < PICK_CACHE_TTL_MS) continue;

    try {
      const data = await fplService.getGwPicks(teamId, gameweek);
      picksCache.set(key, {
        at: Date.now(),
        picks: (data?.picks || []) as PicksRow[],
        hits: data?.entry_history?.event_transfers_cost || 0,
      });
      fetched += 1;
      // Only throttle on a real fetch, and lightly — cached managers cost
      // nothing, so a steady state pass makes almost no requests at all.
      await sleep(120);
    } catch (e) {
      failed += 1;
      // Leave any existing cache in place rather than replacing it with nothing.
    }
  }

  // ---- 4. Score everyone from memory ----
  let scored = 0;
  let skipped = 0;

  for (const entry of entries) {
    const teamId = entry.user.fplTeamId!;
    const cached = picksCache.get(cacheKey(teamId, gameweek));
    if (!cached) {
      skipped += 1;
      continue; // never write a zero for a manager we could not read
    }

    let points = 0;
    let captainPoints = 0;
    let benchPoints = 0;

    for (const p of cached.picks) {
      const base = livePoints[p.element] ?? 0;
      if (p.multiplier > 0) {
        points += base * p.multiplier;
        if (p.is_captain) captainPoints = base * p.multiplier;
      } else {
        benchPoints += base;
      }
    }
    points -= cached.hits;

    await prisma.gwScore.upsert({
      where: { entryId_gameweek: { entryId: entry.id, gameweek } },
      create: {
        entry: { connect: { id: entry.id } },
        league: { connect: { id: entry.league.id } },
        gameweek,
        points,
        captainPoints,
        pointsOnBench: benchPoints,
      },
      update: {
        points,
        captainPoints,
        pointsOnBench: benchPoints,
        syncedAt: new Date(),
      },
    });
    scored += 1;
  }

  console.log(
    `[bulkSync] GW${gameweek}: scored ${scored}, skipped ${skipped}, ` +
    `picks fetched ${fetched} of ${uniqueTeamIds.length} (rest cached), failed ${failed}`
  );

  return { scored, skipped, fetched, cached: uniqueTeamIds.length - fetched, failed };
}

/**
 * Read a whole FPL league's standings in bulk — 50 managers per call.
 * This is what makes mini-league import viable: a 20-person league costs one
 * request, and a thousand imported leagues costs a thousand, not twenty thousand.
 */
export async function readLeagueBulk(fplLeagueId: number, maxPages = 4) {
  const managers: Array<{ entry: number; entryName: string; playerName: string; rank: number }> = [];

  for (let page = 1; page <= maxPages; page++) {
    let data: any;
    try {
      data = await fplService.getLeagueStandings(fplLeagueId, page);
    } catch (e) {
      break;
    }
    const rows = data?.standings?.results || [];
    for (const r of rows) {
      managers.push({
        entry: r.entry,
        entryName: r.entry_name,
        playerName: r.player_name,
        rank: r.rank,
      });
    }
    if (!data?.standings?.has_next) break;
    await sleep(150);
  }

  return {
    leagueName: managers.length ? undefined : undefined,
    managers,
  };
}

/** Clear cached picks for a gameweek — used when a gameweek is re-opened. */
export function clearPicksCache(gameweek?: number) {
  if (gameweek == null) {
    picksCache.clear();
    return;
  }
  for (const key of Array.from(picksCache.keys())) {
    if (key.endsWith(":" + gameweek)) picksCache.delete(key);
  }
}
