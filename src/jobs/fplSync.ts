import cron from "node-cron";
import { prisma } from "../utils/prisma";
import { fplService } from "../services/fpl";
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

  console.log("FPL sync jobs started");
}

async function syncScores() {
  const gw = await fplService.getCurrentGameweek();
  if (!gw) return;

  const entries = await prisma.entry.findMany({
    where: {
      league: { status: "ACTIVE", startGameweek: { lte: gw }, endGameweek: { gte: gw } },
    },
    include: { user: { select: { fplTeamId: true } }, league: true },
  });

  let synced = 0;
  for (const entry of entries) {
    if (!entry.user.fplTeamId) continue;
    try {
      const picks = await fplService.getGwPicks(entry.user.fplTeamId, gw);
      if (!picks) continue;

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

      // Recalculate total from history
      const hist = await fplService.getHistory(entry.user.fplTeamId);
      const total = hist.current.reduce((sum: number, g: any) => {
        if (g.event >= entry.league.startGameweek && g.event <= entry.league.endGameweek)
          return sum + g.points - g.event_transfers_cost;
        return sum;
      }, 0);

      await prisma.entry.update({
        where: { id: entry.id },
        data: { totalPoints: total, previousRank: entry.currentRank },
      });

      synced++;
      await sleep(250);
    } catch (e) { console.error(`Entry ${entry.id} failed`, e); }
  }

  await updateRankings();
  io.emit("scores:updated", { gameweek: gw, at: new Date().toISOString() });

  await prisma.fplSync.create({
    data: { gameweek: gw, status: "success", recordsUpdated: synced },
  });
  console.log(`[Sync] GW${gw}: ${synced}/${entries.length} entries updated`);
}

async function updateRankings() {
  const leagues = await prisma.league.findMany({
    where: { status: "ACTIVE" },
    include: { entries: { where: {}, orderBy: { totalPoints: "desc" } } },
  });

  for (const league of leagues) {
    for (let i = 0; i < league.entries.length; i++) {
      await prisma.entry.update({
        where: { id: league.entries[i].id },
        data: { currentRank: i + 1 },
      });
    }

    // Send live leaderboard update to league room
    io.to(`league:${league.id}`).emit("leaderboard:updated", { leagueId: league.id });
  }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }