import { prisma } from "../utils/prisma";
import { fplService } from "./fpl";

/**
 * Divisions and fixtures.
 *
 * A league is split into tiers of roughly equal size. Within a tier everyone
 * plays everyone once, one opponent per gameweek, three points for a win and
 * one for a draw. At the end of a cycle the top few go up and the bottom few
 * go down, and a fresh set of fixtures is generated.
 *
 * The point of this over a cumulative points table is that nobody is ever out
 * of it. You always have a specific opponent this week, and a bad start does
 * not remove your reason to open the app.
 */

// Division sizing. Target 10 per division so a league of 13 splits into a
// Premier and a League One rather than sitting in one flat table, and so late
// joiners have somewhere to land. Applies to imported mini-leagues too.
export const TARGET_DIVISION_SIZE = 10;
export const MIN_DIVISION_SIZE = 4;
// Two up, two down. Three would turn over half a small division each cycle,
// which stops rivalries forming.
export const PROMOTION_PLACES = 2;
export const RELEGATION_PLACES = 2;
// Promotion is NOT time based. A cycle ends when every division in the league
// has settled all of its fixtures — see runPromotionRelegation — so each tier
// plays everyone once (or twice, below) and the table is genuinely decided
// before anyone moves. This constant is only a floor for how long a generated
// cycle should last.
export const CYCLE_GAMEWEEKS = 4;

// A small division completes a single round robin very quickly — four players
// take three gameweeks — which would leave them idle while a larger tier is
// still playing. Below this size we run the round robin twice, home and away,
// exactly as a real league would.
export const DOUBLE_ROUND_ROBIN_BELOW = 6;

// The pyramid. Elite sits at the top and only opens once a league is big
// enough to fill it without spreading everyone thin (see ELITE_MIN_MEMBERS).
const TIER_NAMES = [
  "Elite",
  "Premier",
  "Championship",
  "League One",
  "League Two",
];

// Below this, a league runs without an Elite tier — the names shift up so a
// small league is Premier / Championship rather than Elite / Premier. Four
// managers in a division play three fixtures and then repeat, which is thin,
// so Elite waits until there are enough people to make it mean something.
export const ELITE_MIN_MEMBERS = 20;
export const ELITE_SIZE = 10;

export function tierName(tier: number, hasElite = true) {
  const names = hasElite ? TIER_NAMES : TIER_NAMES.slice(1);
  return names[tier - 1] || `Division ${tier}`;
}

/**
 * Round robin using the circle method. With an odd number of players a null is
 * added, and whoever draws it that round gets a bye.
 *
 * Returns rounds[] where each round is an array of [home, away] pairs.
 */
export function roundRobin<T>(players: T[]): Array<Array<[T, T | null]>> {
  const list: Array<T | null> = [...players];
  if (list.length % 2 !== 0) list.push(null);

  const n = list.length;
  const rounds: Array<Array<[T, T | null]>> = [];

  for (let r = 0; r < n - 1; r++) {
    const pairs: Array<[T, T | null]> = [];
    for (let i = 0; i < n / 2; i++) {
      const home = list[i];
      const away = list[n - 1 - i];
      if (home === null && away === null) continue;
      // Alternate home and away by round so it is not always the same way round.
      if (home === null) {
        pairs.push([away as T, null]);
      } else if (away === null) {
        pairs.push([home as T, null]);
      } else if (r % 2 === 0) {
        pairs.push([home as T, away as T]);
      } else {
        pairs.push([away as T, home as T]);
      }
    }
    rounds.push(pairs);

    // Rotate everything except the first element.
    const fixed = list[0];
    const rest = list.slice(1);
    rest.unshift(rest.pop() as T | null);
    list.length = 0;
    list.push(fixed, ...rest);
  }

  return rounds;
}

/** How many tiers a league of this size should have. */
export function divisionCountFor(memberCount: number) {
  if (memberCount < MIN_DIVISION_SIZE) return 0;
  // With Elite open, it takes a fixed ELITE_SIZE off the top and the remainder
  // splits into target-sized divisions below it.
  if (memberCount >= ELITE_MIN_MEMBERS) {
    const below = memberCount - ELITE_SIZE;
    return 1 + Math.max(1, Math.ceil(below / TARGET_DIVISION_SIZE));
  }
  return Math.max(1, Math.ceil(memberCount / TARGET_DIVISION_SIZE));
}

/**
 * Builds divisions and a full fixture list for a league, starting at the given
 * gameweek. Existing divisions for the same cycle are replaced.
 *
 * Seeding: entries are ordered by their current total points, so the strongest
 * managers land in tier 1 on the first run. After that, promotion and
 * relegation decide who sits where.
 */

/**
 * The full set of rounds a division should play. Small divisions play everyone
 * twice, home and away, so they are not sitting idle while a bigger tier is
 * still working through its single round robin.
 */
export function scheduleFor<T>(players: T[]): Array<Array<[T, T | null]>> {
  const single = roundRobin(players);
  if (players.length >= DOUBLE_ROUND_ROBIN_BELOW) return single;
  const reverse = single.map((round) =>
    round.map(([home, away]) => [away, home] as [T | null, T | null])
  ) as Array<Array<[T, T | null]>>;
  return single.concat(reverse);
}

export async function buildDivisions(leagueId: string, startGameweek: number, cycle = 1) {
  const league = await prisma.league.findUnique({ where: { id: leagueId } });
  if (!league) throw new Error("League not found.");

  const entries = await prisma.entry.findMany({
    where: { leagueId },
    orderBy: [{ totalPoints: "desc" }, { joinedAt: "asc" }],
    select: { id: true },
  });

  const count = divisionCountFor(entries.length);
  if (count === 0) {
    return { divisions: 0, fixtures: 0, reason: `Needs at least ${MIN_DIVISION_SIZE} members.` };
  }

  // Elite only opens once the league is big enough to fill it without leaving
  // the tiers below too thin to be a real competition.
  const hasElite = entries.length >= ELITE_MIN_MEMBERS;

  // Clear anything already generated for this cycle.
  const existing = await prisma.division.findMany({
    where: { leagueId, cycle },
    select: { id: true },
  });
  if (existing.length) {
    const ids = existing.map((d) => d.id);
    await prisma.fixture.deleteMany({ where: { divisionId: { in: ids } } });
    await prisma.entry.updateMany({
      where: { divisionId: { in: ids } },
      data: { divisionId: null },
    });
    await prisma.division.deleteMany({ where: { id: { in: ids } } });
  }

  // Elite is a fixed size; everyone else splits evenly below it.
  const eliteTake = hasElite ? Math.min(ELITE_SIZE, entries.length) : 0;
  const remaining = entries.length - eliteTake;
  const lowerDivisions = Math.max(1, hasElite ? count - 1 : count);
  const perDivision = Math.ceil(remaining / lowerDivisions);
  let totalFixtures = 0;

  for (let tier = 1; tier <= count; tier++) {
    let slice;
    if (hasElite && tier === 1) {
      slice = entries.slice(0, eliteTake);
    } else {
      const idx = hasElite ? tier - 2 : tier - 1;
      slice = entries.slice(eliteTake + idx * perDivision,
                            eliteTake + (idx + 1) * perDivision);
    }
    if (slice.length < 2) continue;

    const rounds = scheduleFor(slice.map((e) => e.id));
    const endGameweek = Math.min(38, startGameweek + rounds.length - 1);

    const division = await prisma.division.create({
      data: {
        leagueId,
        tier,
        name: tierName(tier, hasElite),
        cycle,
        startGameweek,
        endGameweek,
      },
    });

    await prisma.entry.updateMany({
      where: { id: { in: slice.map((e) => e.id) } },
      data: { divisionId: division.id, played: 0, won: 0, drawn: 0, lost: 0, leaguePoints: 0 },
    });

    const rows: any[] = [];
    rounds.forEach((pairs, idx) => {
      const gameweek = startGameweek + idx;
      if (gameweek > 38) return;
      pairs.forEach(([home, away]) => {
        rows.push({
          divisionId: division.id,
          round: idx + 1,
          gameweek,
          homeEntryId: home,
          awayEntryId: away,
        });
      });
    });

    if (rows.length) {
      await prisma.fixture.createMany({ data: rows });
      totalFixtures += rows.length;
    }
  }

  return { divisions: count, fixtures: totalFixtures };
}

/**
 * Settles fixtures for every gameweek that has FINISHED and still has results
 * outstanding.
 *
 * This deliberately does not work from the current gameweek. A gameweek becomes
 * "current" at its deadline, hours before a ball is kicked, so settling then
 * concluded every fixture on nil.
 */
export async function settlePendingFixtures() {
  const pending = await prisma.fixture.findMany({
    where: { settled: false },
    select: { gameweek: true },
    distinct: ["gameweek"],
    orderBy: { gameweek: "asc" },
  });
  if (!pending.length) return 0;

  let total = 0;
  for (const row of pending) {
    let finished = false;
    try {
      finished = await fplService.isGwFinished(row.gameweek);
    } catch (e) {
      continue; // FPL unavailable, try again next pass
    }
    if (!finished) continue;
    total += await settleFixtures(row.gameweek, true);
  }
  return total;
}

/**
 * Settles every unsettled fixture for one gameweek, using the scores the sync
 * job has already written. A bye is worth a win, so nobody is punished for an
 * odd division size.
 */
export async function settleFixtures(gameweek: number, force = false) {
  // Results are only final once every match in the gameweek has been played.
  if (!force) {
    const finished = await fplService.isGwFinished(gameweek);
    if (!finished) return 0;
  }

  const fixtures = await prisma.fixture.findMany({
    where: { gameweek, settled: false },
  });
  if (!fixtures.length) return 0;

  let settled = 0;

  for (const f of fixtures) {
    const [home, away] = await Promise.all([
      prisma.gwScore.findFirst({
        where: { entryId: f.homeEntryId, gameweek },
        orderBy: { syncedAt: "desc" },
        select: { points: true },
      }),
      f.awayEntryId
        ? prisma.gwScore.findFirst({
            where: { entryId: f.awayEntryId, gameweek },
            orderBy: { syncedAt: "desc" },
            select: { points: true },
          })
        : Promise.resolve(null),
    ]);

    // No score yet means the gameweek has not been synced for this manager.
    if (!home) continue;
    if (f.awayEntryId && !away) continue;

    const homePoints = home.points;
    const awayPoints = away ? away.points : 0;

    await prisma.$transaction(async (tx) => {
      await tx.fixture.update({
        where: { id: f.id },
        data: { homePoints, awayPoints, settled: true, settledAt: new Date() },
      });

      if (!f.awayEntryId) {
        // Bye: counts as a win.
        await tx.entry.update({
          where: { id: f.homeEntryId },
          data: {
            played: { increment: 1 },
            won: { increment: 1 },
            leaguePoints: { increment: 3 },
          },
        });
        return;
      }

      const homeWin = homePoints > awayPoints;
      const draw = homePoints === awayPoints;

      await tx.entry.update({
        where: { id: f.homeEntryId },
        data: {
          played: { increment: 1 },
          won: { increment: homeWin ? 1 : 0 },
          drawn: { increment: draw ? 1 : 0 },
          lost: { increment: !homeWin && !draw ? 1 : 0 },
          leaguePoints: { increment: homeWin ? 3 : draw ? 1 : 0 },
        },
      });

      await tx.entry.update({
        where: { id: f.awayEntryId! },
        data: {
          played: { increment: 1 },
          won: { increment: !homeWin && !draw ? 1 : 0 },
          drawn: { increment: draw ? 1 : 0 },
          lost: { increment: homeWin ? 1 : 0 },
          leaguePoints: { increment: !homeWin && !draw ? 3 : draw ? 1 : 0 },
        },
      });

      // A result each manager can see in their feed. Without this the
      // notifications list only ever holds the welcome messages.
      const sides = await tx.entry.findMany({
        where: { id: { in: [f.homeEntryId, f.awayEntryId!] } },
        include: { user: { select: { id: true, displayName: true } } },
      });
      const home = sides.find((e) => e.id === f.homeEntryId);
      const away = sides.find((e) => e.id === f.awayEntryId);

      if (home && away) {
        const line = (mine: number, theirs: number, opponent: string) =>
          mine > theirs
            ? `You beat ${opponent} ${mine} - ${theirs}.`
            : mine < theirs
            ? `${opponent} beat you ${theirs} - ${mine}.`
            : `You drew ${mine} - ${theirs} with ${opponent}.`;

        await tx.notification.createMany({
          data: [
            {
              userId: home.user.id,
              title: `GW${gameweek} result`,
              body: line(homePoints, awayPoints, away.user.displayName),
              type: "result",
            },
            {
              userId: away.user.id,
              title: `GW${gameweek} result`,
              body: line(awayPoints, homePoints, home.user.displayName),
              type: "result",
            },
          ],
        });
      }
    });

    settled++;
  }

  return settled;
}

/**
 * When every fixture in a cycle is settled, move the top and bottom few between
 * tiers and generate the next cycle's fixtures.
 */
export async function runPromotionRelegation(leagueId: string, nextStartGameweek: number) {
  const divisions = await prisma.division.findMany({
    where: { leagueId },
    orderBy: [{ cycle: "desc" }, { tier: "asc" }],
  });
  if (!divisions.length) return { moved: 0 };

  const cycle = divisions[0].cycle;
  const current = divisions.filter((d) => d.cycle === cycle);

  const outstanding = await prisma.fixture.count({
    where: { divisionId: { in: current.map((d) => d.id) }, settled: false },
  });
  if (outstanding > 0) return { moved: 0, reason: "Cycle still in progress." };

  // Standings per tier, best first.
  const standings = await Promise.all(
    current.map((d) =>
      prisma.entry.findMany({
        where: { divisionId: d.id },
        orderBy: [{ leaguePoints: "desc" }, { totalPoints: "desc" }],
        select: { id: true },
      })
    )
  );

  const order: string[] = [];
  standings.forEach((tierEntries, i) => {
    const up = i === 0 ? [] : tierEntries.slice(0, PROMOTION_PLACES).map((e) => e.id);
    const down =
      i === standings.length - 1
        ? []
        : tierEntries.slice(-RELEGATION_PLACES).map((e) => e.id);
    const stay = tierEntries
      .map((e) => e.id)
      .filter((id) => !up.includes(id) && !down.includes(id));
    order.push(...up, ...stay, ...down);
  });

  // buildDivisions seeds on totalPoints, so write the new order into a rank we
  // can seed from instead: rebuild explicitly in the order worked out above.
  await prisma.$transaction(
    order.map((id, idx) =>
      prisma.entry.update({ where: { id }, data: { currentRank: idx + 1 } })
    )
  );

  await buildDivisionsFromOrder(leagueId, order, nextStartGameweek, cycle + 1);
  return { moved: order.length, cycle: cycle + 1 };
}

/** Same as buildDivisions but with an explicit seeding order. */
export async function buildDivisionsFromOrder(
  leagueId: string,
  orderedEntryIds: string[],
  startGameweek: number,
  cycle: number
) {
  const count = divisionCountFor(orderedEntryIds.length);
  if (count === 0) return { divisions: 0, fixtures: 0 };

  const perDivision = Math.ceil(orderedEntryIds.length / count);
  let totalFixtures = 0;

  for (let tier = 1; tier <= count; tier++) {
    const slice = orderedEntryIds.slice((tier - 1) * perDivision, tier * perDivision);
    if (slice.length < 2) continue;

    const rounds = scheduleFor(slice);
    const endGameweek = Math.min(38, startGameweek + rounds.length - 1);

    const division = await prisma.division.create({
      data: { leagueId, tier, name: tierName(tier), cycle, startGameweek, endGameweek },
    });

    await prisma.entry.updateMany({
      where: { id: { in: slice } },
      data: { divisionId: division.id, played: 0, won: 0, drawn: 0, lost: 0, leaguePoints: 0 },
    });

    const rows: any[] = [];
    rounds.forEach((pairs, idx) => {
      const gameweek = startGameweek + idx;
      if (gameweek > 38) return;
      pairs.forEach(([home, away]) => {
        rows.push({
          divisionId: division.id,
          round: idx + 1,
          gameweek,
          homeEntryId: home,
          awayEntryId: away,
        });
      });
    });

    if (rows.length) {
      await prisma.fixture.createMany({ data: rows });
      totalFixtures += rows.length;
    }
  }

  return { divisions: count, fixtures: totalFixtures };
}
