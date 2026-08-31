import cron from "node-cron";
import { prisma } from "../utils/prisma";
import { fplService } from "../services/fpl";
import { newContext, scoreForFormat, captainPointsForGw } from "../services/scoreFormats";
import { io } from "../index";

export function startSyncJobs() {
  // Every 30 min — sync live scores
  cron.schedule("*/30 * * * *", async () => {
    try { await syncScores(); } catch (e) { console.error("Sync failed", e); }
  });

  // Every hour — update platform + league rankings
  cron.schedule("0 * * * *", async () => {
    try { await updateRankings(); } catch (e) { console.error("Rankings failed", e); }
  });

  // Run once shortly after boot so a deploy does not wait up to 30 minutes.
  setTimeout(() => {
    syncScores().catch((e) => console.error("Initial sync failed", e));
  }, 20000);

  console.log("FPL sync jobs started");
}

/**
 * Leagues are created as UPCOMING. Once the season reaches a league's start
 * gameweek it must become ACTIVE, otherwise the sync below skips its entries
 * and nothing is ever scored. Previously this had to be done by hand, which is
 * exactly how a whole gameweek went unscored.
 */
export async function activateDueLeagues(gw: number) {
  const started = await prisma.league.updateMany({
    where: { status: "UPCOMING", startGameweek: { lte: gw }, endGameweek: { gte: gw } },
    data: { status: "ACTIVE" },
  });
  if (started.count) console.log(`[Sync] activated ${started.count} leagues for GW${gw}`);

  const done = await prisma.league.updateMany({
    where: { status: "ACTIVE", endGameweek: { lt: gw } },
    data: { status: "COMPLETED" },
  });
  if (done.count) console.log(`[Sync] completed ${done.count} finished leagues`);
}

export async function syncScores() {
  const gw = await fplService.getCurrentGameweek();
  if (!gw) return;

  await activateDueLeagues(gw);

  const entries = await prisma.entry.findMany({
    where: {
      league: { status: "ACTIVE", startGameweek: { lte: gw }, endGameweek: { gte: gw } },
    },
    include: { user: { select: { id: true, fplTeamId: true } }, league: true },
  });

  // One history fetch per manager rather than one per entry — a user in six
  // leagues previously triggered six identical calls.
  // Shared caches for the format engines: picks, live points and transfers are
  // each fetched once per sync rather than once per entry.
  const ctx = newContext(sleep, 250);

  const historyCache = new Map<number, any>();
  async function history(teamId: number) {
    if (historyCache.has(teamId)) return historyCache.get(teamId);
    const h = await fplService.getHistory(teamId);
    historyCache.set(teamId, h);
    await sleep(250);
    return h;
  }

  let synced = 0;
  for (const entry of entries) {
    if (!entry.user.fplTeamId) continue;
    try {
      const picks = await fplService.getGwPicks(entry.user.fplTeamId, gw);
      await sleep(250);
      if (!picks || !picks.entry_history) continue;

      const net = picks.entry_history.points - picks.entry_history.event_transfers_cost;

      await prisma.gwScore.upsert({
        where: { entryId_gameweek: { entryId: entry.id, gameweek: gw } },
        create: {
          entryId: entry.id, leagueId: entry.leagueId, gameweek: gw,
          points: net,
          transfersMade: picks.entry_history.event_transfers,
          pointsOnBench: picks.entry_history.points_on_bench,
          teamSnapshot: picks.picks,
        },
        update: {
          points: net,
          transfersMade: picks.entry_history.event_transfers,
          pointsOnBench: picks.entry_history.points_on_bench,
          teamSnapshot: picks.picks,
          syncedAt: new Date(),
        },
      });

      const hist = await history(entry.user.fplTeamId);

      // Cumulative total, which is what a season league ranks on.
      const cumulative = (hist?.current || []).reduce((sum: number, g: any) => {
        if (g.event >= entry.league.startGameweek && g.event <= entry.league.endGameweek)
          return sum + g.points - g.event_transfers_cost;
        return sum;
      }, 0);

      // Bonus formats rank on something else entirely. scoreForFormat returns
      // null for the plain formats so they keep the cumulative behaviour.
      let total = cumulative;
      try {
        const special = await scoreForFormat(
          (entry.league as any).format || "SEASON_TOTAL",
          ctx,
          entry.user.fplTeamId,
          hist,
          entry.league.startGameweek,
          entry.league.endGameweek
        );
        if (special !== null) total = special;
      } catch (e) {
        console.error(`Format scoring failed for entry ${entry.id}`, e);
      }

      // Captain points are worth storing per gameweek regardless of format, so
      // Captain Royale has history to read rather than starting from zero.
      try {
        const capPts = await captainPointsForGw(ctx, entry.user.fplTeamId, gw);
        await prisma.gwScore.update({
          where: { entryId_gameweek: { entryId: entry.id, gameweek: gw } },
          data: { captainPoints: capPts },
        });
      } catch (e) {
        /* not worth failing the entry over */
      }

      await prisma.entry.update({
        where: { id: entry.id },
        data: { totalPoints: total, previousRank: entry.currentRank },
      });

      synced++;
    } catch (e) { console.error(`Entry ${entry.id} failed`, e); }
  }

  await updateUserTotals(historyCache);
  await updateRankings();
  io.emit("scores:updated", { gameweek: gw, at: new Date().toISOString() });

  await prisma.fplSync.create({
    data: { gameweek: gw, status: "success", recordsUpdated: synced },
  });
  console.log(`[Sync] GW${gw}: ${synced}/${entries.length} entries updated`);
}

/**
 * Roll season totals up onto the user record. The app's Home tiles read from
 * the user, not from entries, so without this they stay on zero however well
 * the per-league scoring works.
 */
async function updateUserTotals(historyCache: Map<number, any>) {
  const users = await prisma.user.findMany({
    where: { fplTeamId: { not: null } },
    select: { id: true, fplTeamId: true },
  });

  for (const u of users) {
    try {
      let hist = historyCache.get(u.fplTeamId!);
      if (!hist) {
        hist = await fplService.getHistory(u.fplTeamId!);
        historyCache.set(u.fplTeamId!, hist);
        await sleep(250);
      }
      let total = (hist?.current || []).reduce(
        (sum: number, g: any) => sum + g.points - g.event_transfers_cost,
        0
      );

      // FPL does not add a gameweek to its history endpoint until that gameweek
      // is finished, so mid-gameweek this reads zero. Fall back to the scores we
      // have already stored, taking one row per gameweek since a manager in six
      // leagues has six identical rows.
      if (total === 0) {
        const rows = await prisma.gwScore.findMany({
          where: { entry: { userId: u.id } },
          select: { gameweek: true, points: true },
        });
        const byGw = new Map<number, number>();
        for (const r of rows) if (!byGw.has(r.gameweek)) byGw.set(r.gameweek, r.points);
        total = Array.from(byGw.values()).reduce((a, b) => a + b, 0);
      }

      await prisma.user.update({ where: { id: u.id }, data: { totalPoints: total } });
    } catch (e) {
      console.error(`User totals failed for ${u.id}`, e);
    }
  }

  const ranked = await prisma.user.findMany({
    where: { fplTeamId: { not: null } },
    orderBy: { totalPoints: "desc" },
    select: { id: true },
  });
  for (let i = 0; i < ranked.length; i++) {
    await prisma.user.update({ where: { id: ranked[i].id }, data: { platformRank: i + 1 } });
  }
}

export async function updateRankings() {
  const leagues = await prisma.league.findMany({
    where: { status: "ACTIVE" },
    include: { entries: { orderBy: { totalPoints: "desc" } } },
  });

  for (const league of leagues) {
    for (let i = 0; i < league.entries.length; i++) {
      await prisma.entry.update({
        where: { id: league.entries[i].id },
        data: { currentRank: i + 1 },
      });
    }
    io.to(`league:${league.id}`).emit("leaderboard:updated", { leagueId: league.id });
  }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
