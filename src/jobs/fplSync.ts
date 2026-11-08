import cron from "node-cron";
import { prisma } from "../utils/prisma";
import { fplService, fplCallCount, fplCallsByEndpoint, fplCallsSince } from "../services/fpl";
import {
  newContext,
  scoreForFormat,
  captainPointsForGw,
  rememberPicks,
  rememberPositionTotals,
  rememberCaptainPoints,
  positionBreakdownForGw,
  pointsFromLive,
} from "../services/scoreFormats";
import { io } from "../index";
import { enforceAccess } from "../services/leagueAccess";

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

/**
 * Score a gameweek.
 *
 * `forGameweek` exists so a suite that was frozen can be caught up after it is
 * paid for: without it, a league that missed GW8 to GW11 would come back with a
 * hole in its table, which is worse than having paused honestly. Left out, this
 * behaves exactly as it always has and scores the live gameweek.
 *
 * Re-scoring a past gameweek is safe. Scores are upserted on (entry, gameweek),
 * and FPL's historical picks and points do not change once a gameweek is over,
 * so running it again produces the same numbers.
 */
export async function syncScores(forGameweek?: number) {
  const startedAt = Date.now();
  const callsBefore = fplCallCount();
  const endpointsBefore = fplCallsByEndpoint();
  const gw = forGameweek ?? (await fplService.getCurrentGameweek());
  if (!gw) return;

  const live = forGameweek === undefined;

  // Freezing, archiving and league activation belong to the live pass only.
  // A backfill is filling in history; it must not decide anybody's fate.
  if (live) {
    await activateDueLeagues(gw);
    try {
      const enforced = await enforceAccess(gw);
      if (enforced.frozen || enforced.archived) {
        console.log(`[Access] froze ${enforced.frozen}, archived ${enforced.archived}`);
      }
    } catch (e) {
      // Never let the paywall stop the scoring. An unpaid league scoring one
      // gameweek too many is a rounding error; a failed sync is a dead product.
      console.error("[Access] enforcement failed, scoring continues", e);
    }
  }

  const entries = await prisma.entry.findMany({
    where: {
      league: {
        status: "ACTIVE",
        startGameweek: { lte: gw },
        endGameweek: { gte: gw },
        // Nobody is paying for these, so they do not get scored. Clashd's own
        // competitions are FREE and always pass this.
        access: { notIn: ["FROZEN", "ARCHIVED"] },
      },
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

  // Picks are a property of a manager and a gameweek, not of an entry, and the
  // gameweek is fixed for the whole pass - so a manager in thirteen
  // competitions was fetching the same payload thirteen times, at 250ms each.
  // That put the ceiling at roughly 400 managers before a pass outran the
  // 30-minute cron. One fetch per manager puts it past 5,000.
  const picksCache = new Map<number, any>();
  async function gwPicks(teamId: number) {
    if (picksCache.has(teamId)) return picksCache.get(teamId);
    const p = await fplService.getGwPicks(teamId, gw);
    picksCache.set(teamId, p);
    await sleep(250);
    return p;
  }

  // Load every settled gameweek's squad out of our own database instead of
  // asking FPL for it again.
  //
  // The positional competitions and Captain Royale score by walking the season,
  // so each manager cost one FPL call per gameweek played, on every pass, every
  // thirty minutes - for gameweeks that finished weeks ago and can never
  // change. That, not the database or the host, is what caps how many managers
  // Clashd can carry, and it tightens by one call per manager every week.
  //
  // We already stored each squad in gw_scores.teamSnapshot the first time we
  // scored it. A gameweek FPL reports as data_checked is final - bonus applied,
  // automatic substitutions made - so that snapshot is the truth and nothing is
  // gained by fetching it twice.
  //
  // Done in batches so the rows never all sit in memory at once: a manager in
  // thirteen competitions has thirteen identical snapshots per gameweek, and
  // the first one primes the cache for the rest.
  const managerIds = Array.from(
    new Set(entries.map((e) => e.user.fplTeamId).filter(Boolean))
  ) as number[];

  const settled = new Map<number, boolean>();
  async function isSettled(g: number): Promise<boolean> {
    if (!settled.has(g)) settled.set(g, await fplService.isGwFinished(g));
    return settled.get(g)!;
  }

  let primed = 0;
  let rejected = 0;
  let fromColumns = 0;
  const backfill: Array<{ teamId: number; gameweek: number }> = [];
  const BACKFILL_LIMIT = 300;
  const BATCH = 50;
  for (let i = 0; i < managerIds.length; i += BATCH) {
    const batch = managerIds.slice(i, i + BATCH);
    const rows = await prisma.gwScore.findMany({
      where: {
        gameweek: { lt: gw },
        entry: { user: { fplTeamId: { in: batch } } },
      },
      select: {
        gameweek: true,
        teamSnapshot: true,
        gkPoints: true,
        defPoints: true,
        midPoints: true,
        fwdPoints: true,
        captainPoints: true,
        entry: { select: { user: { select: { fplTeamId: true } } } },
      },
    });

    for (const row of rows) {
      const teamId = row.entry?.user?.fplTeamId;
      if (!teamId) continue;
      const key = `${teamId}:${row.gameweek}`;
      if (ctx.subtotals.has(key) || ctx.picks.has(key)) continue;
      if (!(await isSettled(row.gameweek))) continue;

      // The cheapest case, and the one we want every gameweek to end up in:
      // the four numbers are already on the row, so there is no squad to hold
      // in memory, no arithmetic to redo and nothing to ask FPL.
      if (
        row.gkPoints !== null &&
        row.defPoints !== null &&
        row.midPoints !== null &&
        row.fwdPoints !== null
      ) {
        rememberPositionTotals(ctx, teamId, row.gameweek, {
          gk: row.gkPoints,
          def: row.defPoints,
          mid: row.midPoints,
          fwd: row.fwdPoints,
        });
        // Captain Royale walks the season too, so give it the stored figure as
        // well. The four subtotals being present is what vouches for this row:
        // they are only ever written together with a verified captain figure.
        rememberCaptainPoints(ctx, teamId, row.gameweek, row.captainPoints);
        fromColumns++;
        continue;
      }

      // Scored before those columns existed. Fall back to the stored squad and
      // queue the gameweek to have its numbers worked out once, below.
      const squad = row.teamSnapshot as any;
      if (!Array.isArray(squad) || !squad.length) continue;

      // Fail safe rather than silently wrong. Positional scoring skips any
      // pick without a multiplier, so a snapshot that is not shaped like FPL's
      // picks array would quietly score every manager zero instead of raising
      // anything. If it does not look right, leave it alone and let FPL serve
      // that gameweek exactly as it did before.
      const first = squad[0];
      if (!first || first.element === undefined || first.multiplier === undefined) {
        rejected++;
        continue;
      }

      // Keep only the three fields scoring reads. A full snapshot carries
      // position and vice-captain flags nobody looks at here.
      rememberPicks(
        ctx,
        teamId,
        row.gameweek,
        squad.map((pick: any) => ({
          element: pick.element,
          multiplier: pick.multiplier,
          is_captain: pick.is_captain,
        }))
      );
      primed++;
      if (backfill.length < BACKFILL_LIMIT) {
        backfill.push({ teamId, gameweek: row.gameweek });
      }
    }
  }

  // Shadow check for bulk scoring. Changes nothing.
  //
  // The way past the next ceiling is to stop asking FPL for each manager's
  // score and work it out ourselves: one call returns every player's points,
  // and we already know who was in each squad. bulkSync.ts has done this since
  // September and has never been switched on, because nobody has ever checked
  // that its answer matches the one FPL gives us.
  //
  // So compute it alongside the real figure and log where the two disagree.
  // Whatever we learn here decides whether the bulk path can be trusted, and
  // the disagreements will name the reason - most likely provisional bonus
  // during a match, or automatic substitutions applied after it.
  let shadowLive: Record<number, number> | null = null;
  const shadowSeen = new Set<number>();
  let shadowAgreed = 0;
  let shadowDiffered = 0;
  const shadowExamples: string[] = [];

  async function shadowCheck(teamId: number, picks: any, actual: number) {
    if (shadowSeen.has(teamId)) return;
    shadowSeen.add(teamId);
    try {
      if (!shadowLive) shadowLive = await fplService.getLiveGwPoints(gw);
      if (!shadowLive || !Object.keys(shadowLive).length) return;

      const computed = pointsFromLive(picks, shadowLive);

      if (computed === actual) {
        shadowAgreed++;
      } else {
        shadowDiffered++;
        if (shadowExamples.length < 3) {
          shadowExamples.push(`team ${teamId}: computed ${computed}, FPL ${actual}`);
        }
      }
    } catch {
      /* a shadow check must never affect a real pass */
    }
  }

  // Work out the four numbers once for gameweeks scored before the columns
  // existed, and write them to the row so no pass ever does it again. Capped
  // per pass so the first run after a deploy cannot turn into a long job, and
  // the rest simply fills in over the following passes.
  let backfilled = 0;
  let backfillError = "";
  for (const job of backfill) {
    try {
      const parts = await positionBreakdownForGw(ctx, job.teamId, job.gameweek);
      // Recompute the captain figure from the same squad rather than trusting
      // whatever is on the row. That column defaults to zero, so a gameweek the
      // sync missed while it was live - GW4 in September, for one - would be
      // indistinguishable from a captain who genuinely blanked.
      const capPts = await captainPointsForGw(ctx, job.teamId, job.gameweek);
      await prisma.gwScore.updateMany({
        where: {
          gameweek: job.gameweek,
          entry: { user: { fplTeamId: job.teamId } },
        },
        data: {
          gkPoints: parts.gk,
          defPoints: parts.def,
          midPoints: parts.mid,
          fwdPoints: parts.fwd,
          captainPoints: capPts,
        },
      });
      rememberPositionTotals(ctx, job.teamId, job.gameweek, parts);
      rememberCaptainPoints(ctx, job.teamId, job.gameweek, capPts);
      backfilled++;
    } catch (e: any) {
      // A backfill is an optimisation and must never break a scoring pass -
      // but it must not fail silently either, or the columns would stay empty
      // for ever while every pass quietly went on doing the work by hand.
      if (!backfillError) backfillError = e?.message || String(e);
    }
  }

  let synced = 0;
  for (const entry of entries) {
    if (!entry.user.fplTeamId) continue;
    try {
      const picks = await gwPicks(entry.user.fplTeamId);
      if (!picks || !picks.entry_history) continue;

      const net = picks.entry_history.points - picks.entry_history.event_transfers_cost;

      await shadowCheck(entry.user.fplTeamId, picks, net);

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
      //
      // Built from the scores we have already stored rather than FPL's history
      // endpoint. History only gains a gameweek once that gameweek is finished,
      // so relying on it left league tables a day behind live play.
      const stored = await prisma.gwScore.findMany({
        where: {
          entryId: entry.id,
          gameweek: { gte: entry.league.startGameweek, lte: entry.league.endGameweek },
        },
        select: { gameweek: true, points: true },
        orderBy: { syncedAt: "desc" },
      });
      const seen = new Map<number, number>();
      for (const row of stored) if (!seen.has(row.gameweek)) seen.set(row.gameweek, row.points);
      let cumulative = Array.from(seen.values()).reduce((a, b) => a + b, 0);

      // Fall back to history if nothing is stored yet, so a first sync still works.
      if (!seen.size) {
        cumulative = (hist?.current || []).reduce((sum: number, g: any) => {
          if (g.event >= entry.league.startGameweek && g.event <= entry.league.endGameweek)
            return sum + g.points - g.event_transfers_cost;
          return sum;
        }, 0);
      }

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

        // A weekly league ranks on this gameweek alone, and `net` is the live
        // figure we just wrote. Using it keeps the weekly table current instead
        // of waiting for FPL to close the gameweek out.
        if ((entry.league as any).format === "WEEKLY_HIGH") total = net;
      } catch (e) {
        console.error(`Format scoring failed for entry ${entry.id}`, e);
      }

      // Captain points are worth storing per gameweek regardless of format, so
      // Captain Royale has history to read rather than starting from zero.
      try {
        const capPts = await captainPointsForGw(ctx, entry.user.fplTeamId, gw);
        const parts = await positionBreakdownForGw(ctx, entry.user.fplTeamId, gw);
        await prisma.gwScore.update({
          where: { entryId_gameweek: { entryId: entry.id, gameweek: gw } },
          data: {
            captainPoints: capPts,
            gkPoints: parts.gk,
            defPoints: parts.def,
            midPoints: parts.mid,
            fwdPoints: parts.fwd,
          },
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

  await updateUserTotals(historyCache, gw);
  await updateRankings();
  io.emit("scores:updated", { gameweek: gw, at: new Date().toISOString() });

  await prisma.fplSync.create({
    data: { gameweek: gw, status: "success", recordsUpdated: synced },
  });
  // What a pass actually costs. The FPL call count is the number that decides
  // how many managers Clashd can carry, so it is logged rather than estimated.
  const seconds = Math.round((Date.now() - startedAt) / 1000);
  const calls = fplCallCount() - callsBefore;
  const perManager = managerIds.length ? (calls / managerIds.length).toFixed(1) : "0";
  console.log(
    `[Sync] GW${gw}: ${synced}/${entries.length} entries updated | ` +
    `${managerIds.length} managers | ${calls} FPL calls (${perManager} each) | ` +
    `${fromColumns} gameweeks from columns | ${primed} from squads | ` +
    `${backfilled} backfilled | ${seconds}s` +
    (backfillError ? ` | BACKFILL FAILED: ${backfillError}` : "") +
    (rejected ? ` | WARNING ${rejected} snapshots had an unexpected shape` : "")
  );

  console.log(`[Sync] GW${gw} calls by endpoint: ${fplCallsSince(endpointsBefore)}`);

  if (shadowAgreed || shadowDiffered) {
    const total = shadowAgreed + shadowDiffered;
    console.log(
      `[Shadow] bulk scoring agreed with FPL on ${shadowAgreed}/${total} managers` +
      (shadowExamples.length ? ` | ${shadowExamples.join(" | ")}` : "")
    );
  }
}

/**
 * Roll season totals up onto the user record. The app's Home tiles read from
 * the user, not from entries, so without this they stay on zero however well
 * the per-league scoring works.
 */
/**
 * Which gameweek we last refreshed team names in. A manager renames their team
 * perhaps once a season, so asking FPL every half hour costs one call and a
 * quarter-second per manager, for ever, to learn nothing. Once a gameweek is
 * far more often than the thing it is watching for actually changes.
 */
let namesRefreshedForGw: number | null = null;

async function updateUserTotals(historyCache: Map<number, any>, gw: number) {
  const refreshNames = namesRefreshedForGw !== gw;
  const users = await prisma.user.findMany({
    where: { fplTeamId: { not: null } },
    select: { id: true, fplTeamId: true, fplTeamName: true },
  });

  for (const u of users) {
    try {
      // Refresh the stored team name. FPL keeps the same Manager ID when a
      // manager renames their team, so a name saved once at link time goes
      // stale. Once a gameweek, not once every half hour.
      if (refreshNames) {
        try {
          const team = await fplService.getTeam(u.fplTeamId!);
          const liveName = team?.name;
          if (liveName && liveName !== u.fplTeamName) {
            await prisma.user.update({
              where: { id: u.id },
              data: { fplTeamName: liveName },
            });
          }
          await sleep(250);
        } catch (e) {
          /* name refresh must not break totals */
        }
      }
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

  // Only once the loop has been all the way through, so a pass that died
  // halfway tries the names again next time rather than skipping them.
  if (refreshNames) namesRefreshedForGw = gw;

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
