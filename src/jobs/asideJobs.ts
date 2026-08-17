import cron from "node-cron";
import { prisma } from "../utils/prisma";
import { fplService } from "../services/fpl";

// The FPL API is unofficial and will throttle or block aggressive callers.
// Every loop that hits it once per user must pace itself, the same way
// fplSync does. At 500 linked users this is the difference between a
// polite two minute pass and 500 requests in a burst.
const FPL_CALL_DELAY_MS = 250;
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Aside jobs run on their own schedule and write only to squad_snapshots and
 * aside_picks. They deliberately never touch Entry or GwScore, so a failure
 * here cannot affect season-long league scoring.
 */
export function startAsideJobs() {
  // Every 20 min — capture squads once a deadline has passed
  cron.schedule("*/20 * * * *", async () => {
    try {
      await captureSquadSnapshots();
    } catch (e) {
      console.error("[aside] snapshot job failed", e);
    }
  });

  // Every 25 min — score Aside picks for the current gameweek
  cron.schedule("5,30,55 * * * *", async () => {
    try {
      await scoreAsidePicks();
    } catch (e) {
      console.error("[aside] scoring job failed", e);
    }
  });

  console.log("Aside jobs started");
}

/**
 * Captures each linked manager's confirmed squad for the current gameweek.
 * FPL only exposes picks after the deadline has passed, so this is the
 * earliest point the data exists. The snapshot becomes the pool players
 * choose from for the following gameweek.
 */
export async function captureSquadSnapshots() {
  const gw = await fplService.getCurrentGameweek();
  if (!gw) return;

  const passed = await fplService.isDeadlinePassed(gw);
  if (!passed) return;

  const users = await prisma.user.findMany({
    where: { fplTeamId: { not: null } },
    select: { id: true, fplTeamId: true },
  });

  let captured = 0;
  for (const u of users) {
    try {
      const existing = await prisma.squadSnapshot.findUnique({
        where: { userId_gameweek: { userId: u.id, gameweek: gw } },
      });
      if (existing) continue;

      const picks = await fplService.getGwPicks(u.fplTeamId!, gw);
      if (!picks?.picks?.length) continue;

      await prisma.squadSnapshot.create({
        data: { userId: u.id, gameweek: gw, picks: picks.picks },
      });
      captured++;
      await sleep(FPL_CALL_DELAY_MS);
    } catch (e) {
      console.error(`[aside] snapshot failed for user ${u.id}`, e);
    }
  }

  if (captured) console.log(`[aside] captured ${captured} squad snapshots for GW${gw}`);
}

/**
 * Scores Aside selections for the current gameweek.
 *
 * Each chosen player is validated against the manager's ACTUAL squad for that
 * gameweek — anyone transferred out after selecting scores zero. This is why we
 * can safely let people pick from last week's squad: the truth is checked here.
 */
export async function scoreAsidePicks() {
  const gw = await fplService.getCurrentGameweek();
  if (!gw) return;

  const passed = await fplService.isDeadlinePassed(gw);
  if (!passed) return;

  const picks = await prisma.asidePick.findMany({
    where: {
      gameweek: gw,
      league: { format: { in: ["SEVEN_ASIDE", "FIVE_ASIDE"] } },
    },
    include: { user: { select: { fplTeamId: true } } },
  });
  if (!picks.length) return;

  const livePoints = await fplService.getLiveGwPoints(gw);
  const actualSquadCache = new Map<number, Set<number>>();

  let scored = 0;
  for (const pick of picks) {
    try {
      const teamId = pick.user.fplTeamId;
      if (!teamId) continue;

      // The manager's real squad this gameweek (cached per team).
      let actual = actualSquadCache.get(teamId);
      if (!actual) {
        const gwPicks = await fplService.getGwPicks(teamId, gw);
        actual = new Set<number>((gwPicks?.picks || []).map((p: any) => p.element));
        actualSquadCache.set(teamId, actual);
        await sleep(FPL_CALL_DELAY_MS);
      }

      const chosen = pick.playerIds as number[];
      let total = 0;
      let invalid = 0;
      for (const id of chosen) {
        if (!actual.has(id)) {
          invalid++;
          continue; // transferred out — scores zero
        }
        total += livePoints[id] ?? 0;
      }

      await prisma.asidePick.update({
        where: { id: pick.id },
        data: {
          score: total,
          invalidCount: invalid,
          scoredAt: new Date(),
          lockedAt: pick.lockedAt ?? new Date(),
        },
      });
      scored++;
    } catch (e) {
      console.error(`[aside] scoring failed for pick ${pick.id}`, e);
    }
  }

  if (scored) console.log(`[aside] scored ${scored} selections for GW${gw}`);
}
