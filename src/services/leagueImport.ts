import { prisma } from "../utils/prisma";
import { clubBandFor, CLUB_PRODUCTS } from "./entitlements";
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


/**
 * The Clashd competition suite. Every imported group gets its own instance of
 * all of these, scored privately among that group — this is what the import fee
 * buys. Clashd's own public leagues are the shop window; these are the product.
 */
const SUITE: Array<{
  suffix: string;
  format: string;
  description: string;
  startOffset: number;
}> = [
  { suffix: "Season",          format: "SEASON_TOTAL",   startOffset: 0,
    description: "Cumulative FPL points across the season." },
  { suffix: "Premier League",  format: "SEASON_TOTAL",   startOffset: 0,
    description: "Head to head each gameweek. Three points for a win." },
  { suffix: "Weekly Battle",   format: "WEEKLY_HIGH",    startOffset: 0,
    description: "Highest score this gameweek. Resets every week." },
  { suffix: "7Aside",          format: "SEVEN_ASIDE",    startOffset: 1,
    description: "Pick 7 of your own squad. Only they score." },
  { suffix: "5Aside",          format: "FIVE_ASIDE",     startOffset: 1,
    description: "Pick 5 of your own squad. Tighter, sharper." },
  { suffix: "Captain Royale",  format: "CAPTAIN_POINTS", startOffset: 0,
    description: "Only your captain counts." },
  { suffix: "No Hit Squad",    format: "NO_HITS",        startOffset: 0,
    description: "Go the season without a points hit." },
  { suffix: "Transfer Genius", format: "TRANSFER_NET",   startOffset: 0,
    description: "Best net return on your transfers." },
  { suffix: "Green Arrow",     format: "RANK_CLIMB",     startOffset: 0,
    description: "Most gameweeks where your rank improves." },
];

/** How many leagues one user may import. */
export const MAX_IMPORTS_PER_USER = 3;

/**
 * What a league costs is a Club pass, not a per-head sum. The bands live in
 * entitlements.ts because that is where the App Store product ids live, and
 * quoting anything else here would show a price that cannot be bought.
 */

export type ImportResult = {
  leagueId: string;
  name: string;
  totalManagers: number;
  onClashd: number;
  pending: number;
  competitions: number;
  /** The Club pass this league needs, or null if it is past the largest band. */
  club: { productId: string; seats: number; price: string; pence: number } | null;
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

  // 3. One import may not be repeated, and a user may only import a few.
  const existing = await prisma.league.findFirst({
    where: { importedFromFplId: fplLeagueId },
  });
  if (existing) {
    throw new Error("That league has already been imported.");
  }

  const mine = await prisma.league.count({
    where: { createdById: ownerUserId, importedFromFplId: { not: null } },
  });
  if (mine >= MAX_IMPORTS_PER_USER) {
    throw new Error(
      `You can import up to ${MAX_IMPORTS_PER_USER} leagues. Remove one first.`
    );
  }

  const currentGw = (await fplService.getCurrentGameweek()) || 1;

  // 4. Create the whole Clashd suite for this group. Nine competitions, scored
  //    privately among these managers — this is what the import fee buys.
  const created: Array<{ id: string; name: string; format: string }> = [];
  let primaryId = "";

  for (let i = 0; i < SUITE.length; i++) {
    const def = SUITE[i];
    const league = await prisma.league.create({
      data: {
        name: leagueName + " " + def.suffix,
        inviteCode: "i" + fplLeagueId.toString(36) + i.toString(36),
        season: SEASON,
        description: def.description,
        format: def.format as any,
        status: "ACTIVE",
        startGameweek: currentGw + def.startOffset,
        endGameweek: 38,
        createdBy: { connect: { id: ownerUserId } },
        // Only the first carries the FPL link, so the league cannot be
        // imported twice and we know which one is the group's home table.
        ...(i === 0 ? { importedFromFplId: fplLeagueId } : {}),
        // Imported leagues are bragging rights only. A member-funded pot would
        // make Clashd a third-party money pool and reopen the gambling question.
        prizeInfo: null,
      },
    });
    created.push({ id: league.id, name: league.name, format: def.format });
    if (i === 0) primaryId = league.id;
  }

  // 5. Add the managers who are already on Clashd to EVERY competition.
  let onClashd = 0;
  for (const m of managers) {
    const userId = knownByFplId.get(m.entry);
    if (!userId) continue;
    for (const c of created) {
      await prisma.entry.create({
        data: {
          user: { connect: { id: userId } },
          league: { connect: { id: c.id } },
        },
      });
    }
    onClashd += 1;
  }

  // 6. Record the rest as PENDING against every competition — entry id only,
  //    nothing identifiable about someone who has not signed up.
  const pendingIds = managers
    .map((m) => m.entry)
    .filter((id) => !knownByFplId.has(id));

  if (pendingIds.length) {
    const rows: Array<{ leagueId: string; fplTeamId: number }> = [];
    for (const c of created) {
      for (const fplTeamId of pendingIds) {
        rows.push({ leagueId: c.id, fplTeamId });
      }
    }
    await prisma.pendingMember.createMany({ data: rows, skipDuplicates: true });
  }

  return {
    leagueId: primaryId,
    name: leagueName,
    totalManagers: managers.length,
    onClashd,
    pending: pendingIds.length,
    competitions: created.length,
    club: clubPassFor(managers.length),
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

/**
 * Join every competition in an imported group from a single code.
 *
 * A member should enter one code and be in all nine, not join them one at a
 * time. Codes for a group all share the same prefix, so one lookup finds the
 * whole suite.
 */
export async function joinImportedSuite(userId: string, inviteCode: string) {
  const code = String(inviteCode || "").trim().toLowerCase();
  if (!code.startsWith("i")) return { joined: 0 };

  // Group prefix is everything but the final character (the suite index).
  const prefix = code.slice(0, -1);

  const leagues = await prisma.league.findMany({
    where: { inviteCode: { startsWith: prefix }, status: "ACTIVE" },
    select: { id: true, name: true },
  });
  if (!leagues.length) return { joined: 0 };

  let joined = 0;
  for (const l of leagues) {
    const already = await prisma.entry.findFirst({
      where: { userId, leagueId: l.id },
    });
    if (already) continue;
    await prisma.entry.create({
      data: {
        user: { connect: { id: userId } },
        league: { connect: { id: l.id } },
      },
    });
    joined += 1;
  }

  // Clear any pending rows for this user in that group.
  const me = await prisma.user.findUnique({
    where: { id: userId },
    select: { fplTeamId: true },
  });
  if (me?.fplTeamId) {
    await prisma.pendingMember.deleteMany({
      where: { fplTeamId: me.fplTeamId, leagueId: { in: leagues.map((l) => l.id) } },
    });
  }

  return { joined, competitions: leagues.length };
}


/** The Club band that covers a league of this size, priced for display. */
export function clubPassFor(managers: number) {
  const band = clubBandFor(managers);
  if (!band) return null;
  const pence = CLUB_PRODUCTS[band.productId].pence;
  return {
    productId: band.productId,
    seats: band.seats,
    price: pence % 100 === 0 ? `£${pence / 100}` : `£${(pence / 100).toFixed(2)}`,
    pence,
  };
}
