import { prisma } from "../utils/prisma";
import { fplService } from "./fpl";
import { readLeagueBulk } from "./bulkSync";

const SEASON = "2026/27";

/**
 * Mini-league import.
 *
 * A Clashd user gives us their FPL mini-league code. We read that league's
 * standings in bulk (50 managers a call) and create a Clashd league mirroring
 * it. The importer becomes its admin.
 *
 * PRIVACY POSITION — this is the part that matters, and it is deliberate:
 *
 *   We do NOT display, store or expose any information about a manager who is
 *   not a Clashd member. No names, no team names, no scores.
 *
 *   What we store for a non-member is ONLY their FPL entry id — a public,
 *   opaque number — so that when they later sign up and link that team, we can
 *   recognise them and place them in the league they already belonged to.
 *
 *   The importer sees "12 managers in this league, 3 on Clashd" — a count, not
 *   a roster. Nobody's details surface until they join and sign up themselves.
 *
 * That keeps us clear of holding identifiable data about people who never
 * consented, while still making the join seamless for them when they arrive.
 */

export type ImportResult = {
  leagueId: string;
  name: string;
  totalManagers: number;
  onClashd: number;
  pending: number;
};

/**
 * Import an FPL mini-league by its numeric id.
 * `ownerUserId` becomes the league admin.
 */
export async function importMiniLeague(
  fplLeagueId: number,
  ownerUserId: string
): Promise<ImportResult> {
  // 1. Read the league in bulk.
  const meta = await fplService.getLeagueStandings(fplLeagueId, 1);
  const leagueName = meta?.league?.name;
  if (!leagueName) throw new Error("Could not find that FPL league.");

  const { managers } = await readLeagueBulk(fplLeagueId);
  if (!managers.length) throw new Error("That league has no managers yet.");

  // 2. Which of them are already Clashd members?
  const fplIds = managers.map((m) => m.entry);
  const known = await prisma.user.findMany({
    where: { fplTeamId: { in: fplIds } },
    select: { id: true, fplTeamId: true },
  });
  const knownByFplId = new Map(known.map((u) => [u.fplTeamId!, u.id]));

  // 3. Create the Clashd league.
  const existing = await prisma.league.findFirst({
    where: { importedFromFplId: fplLeagueId },
  });
  if (existing) {
    throw new Error("That league has already been imported.");
  }

  const currentGw = (await fplService.getCurrentGameweek()) || 1;

  // A short unique code so the league behaves like any other Clashd league.
  const inviteCode = "imp" + fplLeagueId.toString(36);

  const league = await prisma.league.create({
    data: {
      name: leagueName,
      inviteCode,
      season: SEASON,
      description: "Imported from your FPL mini-league.",
      format: "SEASON_TOTAL",
      status: "ACTIVE",
      startGameweek: currentGw,
      endGameweek: 38,
      createdBy: { connect: { id: ownerUserId } },
      importedFromFplId: fplLeagueId,
      // Imported leagues are bragging rights only. Allowing a member-funded
      // prize pot would make Clashd a third-party money pool, which reopens
      // every gambling question the free model avoids.
      prizeInfo: null,
    },
  });

  // 4. Add the members who are already on Clashd.
  let onClashd = 0;
  for (const m of managers) {
    const userId = knownByFplId.get(m.entry);
    if (!userId) continue;
    await prisma.entry.create({
      data: {
        user: { connect: { id: userId } },
        league: { connect: { id: league.id } },
      },
    });
    onClashd += 1;
  }

  // 5. Record the rest as PENDING — entry id only, nothing identifiable.
  //    When one of these managers signs up and links this FPL team, they are
  //    placed in the league automatically (see claimPendingMemberships).
  const pendingIds = managers
    .map((m) => m.entry)
    .filter((id) => !knownByFplId.has(id));

  if (pendingIds.length) {
    await prisma.pendingMember.createMany({
      data: pendingIds.map((fplTeamId) => ({ leagueId: league.id, fplTeamId })),
      skipDuplicates: true,
    });
  }

  return {
    leagueId: league.id,
    name: leagueName,
    totalManagers: managers.length,
    onClashd,
    pending: pendingIds.length,
  };
}

/**
 * When a user links an FPL team, place them into any imported league that was
 * waiting for that team id. This is what makes the import seamless without ever
 * having held their details.
 */
export async function claimPendingMemberships(userId: string, fplTeamId: number) {
  const pending = await prisma.pendingMember.findMany({
    where: { fplTeamId },
    select: { id: true, leagueId: true },
  });
  if (!pending.length) return 0;

  let joined = 0;
  for (const p of pending) {
    const already = await prisma.entry.findFirst({
      where: { userId, leagueId: p.leagueId },
    });
    if (!already) {
      await prisma.entry.create({
        data: {
          user: { connect: { id: userId } },
          league: { connect: { id: p.leagueId } },
        },
      });
      joined += 1;
    }
    await prisma.pendingMember.delete({ where: { id: p.id } });
  }

  if (joined) {
    await prisma.notification.create({
      data: {
        userId,
        title: "You're in",
        body:
          joined === 1
            ? "Your mini-league is already on Clashd, so we have added you to it."
            : `Your mini-leagues are already on Clashd, so we have added you to ${joined} of them.`,
        type: "league_update",
      },
    });
  }

  return joined;
}

/**
 * A count-only summary for the league screen. Deliberately returns numbers, not
 * a roster: nobody who has not joined Clashd is named anywhere.
 */
export async function importedLeagueSummary(leagueId: string) {
  const [members, pending] = await Promise.all([
    prisma.entry.count({ where: { leagueId } }),
    prisma.pendingMember.count({ where: { leagueId } }),
  ]);
  return { onClashd: members, notYetJoined: pending, total: members + pending };
}
