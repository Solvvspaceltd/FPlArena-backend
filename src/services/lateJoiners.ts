import { prisma } from "../utils/prisma";
import {
  tierName,
  roundRobin,
  buildDivisions,
} from "./divisions";
import { fplService } from "./fpl";

/**
 * Late joiners.
 *
 * A league's divisions and fixtures are generated once, so anyone who joins
 * afterwards sits in the league with no division and no fixtures — in the
 * league, unable to play. This places them.
 *
 * The rule, deliberately simple and the same for every league (including the
 * mini-leagues we will import later):
 *
 *   - New entries go into the LOWEST division, which is the fair place to start.
 *   - If the lowest division is full, a new bottom division is created.
 *   - Fixtures are generated for the remaining gameweeks of the current cycle,
 *     so a late joiner starts playing the very next gameweek.
 *
 * Nothing here is specific to Clashd's own leagues, so an imported mini-league
 * gets the same behaviour for free.
 */

const MAX_DIVISION_SIZE = 10;
const MIN_TO_PLAY = 2;

/**
 * Place every entry in a league that has no division yet.
 * Returns how many were placed and which divisions were touched.
 */
export async function placeUnassignedEntries(leagueId: string) {
  const league = await prisma.league.findUnique({ where: { id: leagueId } });
  if (!league) throw new Error("League not found.");

  const unassigned = await prisma.entry.findMany({
    where: { leagueId, divisionId: null },
    orderBy: { joinedAt: "asc" },
    select: { id: true },
  });
  if (!unassigned.length) return { placed: 0, divisions: [] as string[] };

  // The current cycle's divisions, lowest tier last.
  const divisions = await prisma.division.findMany({
    where: { leagueId },
    orderBy: [{ cycle: "desc" }, { tier: "asc" }],
  });

  // No divisions at all yet: this league has never been built. Build it
  // normally instead of bolting people onto nothing.
  if (!divisions.length) {
    const gw = await currentOrNextGameweek(league.startGameweek);
    const res = await buildDivisions(leagueId, gw, 1);
    return { placed: unassigned.length, built: true, ...res };
  }

  const cycle = divisions[0].cycle;
  const current = divisions.filter((d) => d.cycle === cycle);
  const lowest = current[current.length - 1];

  const lowestCount = await prisma.entry.count({ where: { divisionId: lowest.id } });

  const touched = new Set<string>();
  let targetId = lowest.id;
  let targetTier = lowest.tier;
  let room = MAX_DIVISION_SIZE - lowestCount;

  for (const entry of unassigned) {
    if (room <= 0) {
      // Lowest division is full — open a new one below it.
      targetTier = targetTier + 1;
      const created = await prisma.division.create({
        data: {
          leagueId,
          name: tierName(targetTier),
          tier: targetTier,
          cycle,
          startGameweek: lowest.startGameweek,
          endGameweek: lowest.endGameweek,
        },
      });
      targetId = created.id;
      room = MAX_DIVISION_SIZE;
    }

    await prisma.entry.update({
      where: { id: entry.id },
      data: { divisionId: targetId },
    });
    touched.add(targetId);
    room -= 1;
  }

  // Rebuild fixtures for every division we added people to, from the next
  // gameweek onwards. Settled results are left untouched.
  const fromGw = await currentOrNextGameweek(league.startGameweek);
  let fixtures = 0;
  for (const divisionId of touched) {
    fixtures += await regenerateRemainingFixtures(divisionId, fromGw);
  }

  return { placed: unassigned.length, divisions: Array.from(touched), fixtures };
}

/**
 * Regenerate the unplayed fixtures of a division from a gameweek onwards.
 * Settled fixtures are preserved so history is never rewritten.
 */
export async function regenerateRemainingFixtures(divisionId: string, fromGameweek: number) {
  const division = await prisma.division.findUnique({ where: { id: divisionId } });
  if (!division) return 0;

  const entries = await prisma.entry.findMany({
    where: { divisionId },
    orderBy: { totalPoints: "desc" },
    select: { id: true },
  });
  if (entries.length < MIN_TO_PLAY) return 0;

  // Clear only the unsettled fixtures from this gameweek on.
  await prisma.fixture.deleteMany({
    where: { divisionId, settled: false, gameweek: { gte: fromGameweek } },
  });

  const league = await prisma.league.findUnique({ where: { id: division.leagueId } });
  const endGw = league?.endGameweek || 38;

  // Continue round numbering after any settled fixtures, so the unique
  // (divisionId, round, homeEntryId) constraint can't collide with history.
  const lastSettled = await prisma.fixture.findFirst({
    where: { divisionId, settled: true },
    orderBy: { round: "desc" },
    select: { round: true },
  });
  let roundNo = (lastSettled?.round || 0) + 1;

  const rounds = roundRobin(entries.map((e) => e.id));
  const rows: any[] = [];
  let gw = fromGameweek;

  for (const round of rounds) {
    if (gw > endGw) break;
    for (const [home, away] of round) {
      if (!home) continue;
      rows.push({
        divisionId,
        round: roundNo,
        gameweek: gw,
        homeEntryId: home,
        awayEntryId: away,   // null = a bye, counted as a win
        settled: false,
      });
    }
    gw += 1;
    roundNo += 1;
  }

  if (rows.length) await prisma.fixture.createMany({ data: rows });
  return rows.length;
}

/** The gameweek fixtures should start from: the next one not yet played. */
async function currentOrNextGameweek(fallback: number) {
  try {
    const current = await fplService.getCurrentGameweek();
    if (current) return current + 1;
  } catch (e) {
    /* fall through */
  }
  return fallback || 1;
}

/**
 * Sweep every active league and place anyone without a division.
 * Safe to run on a schedule — does nothing when there is nobody to place.
 */
export async function placeAllUnassigned() {
  const leagues = await prisma.league.findMany({
    where: { status: "ACTIVE" },
    select: { id: true, name: true },
  });

  let total = 0;
  for (const l of leagues) {
    try {
      const res = await placeUnassignedEntries(l.id);
      if (res.placed) {
        total += res.placed;
        console.log(`[divisions] placed ${res.placed} late joiner(s) in ${l.name}`);
      }
    } catch (e) {
      console.error(`[divisions] placement failed for ${l.name}`, e);
    }
  }
  return total;
}
