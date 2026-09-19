import { Router } from "express";
import { prisma } from "../utils/prisma";
import { authenticate, AuthRequest } from "../middleware/authenticate";
import { fplService } from "../services/fpl";
import { getCachedFormPicks } from "../jobs/formPicks";
import { dashboardMetrics, biggestLever } from "../services/dashboard";

export const analysisRouter = Router();

/**
 * GET /api/analysis
 *
 * Three layers, all real settled data — no prediction model:
 *   1. Where your points went (bench, captain, hits) — from your own picks.
 *   2. Your rivals own, you don't — differentials vs your league opponents.
 *   3. The in-form 30 — shared weekly intelligence (own / buying / selling).
 */
analysisRouter.get("/", authenticate, async (req: AuthRequest, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { fplTeamId: true },
    });
    if (!user?.fplTeamId) {
      return res.json({ linked: false });
    }

    let gw: number | null = null;
    try {
      gw = await fplService.getCurrentGameweek();
    } catch (e) {
      /* fall through */
    }
    if (!gw) return res.json({ linked: true, ready: false });

    // ---- Layer 1: where your points went ----
    let pointsLeftBehind: any = null;
    try {
      const picks = await fplService.getGwPicks(user.fplTeamId, gw);
      const live = await fplService.getLiveGwPoints(gw);

      const starters = (picks?.picks || []).filter((p: any) => p.multiplier > 0);
      const bench = (picks?.picks || []).filter((p: any) => p.multiplier === 0);
      const captain = (picks?.picks || []).find((p: any) => p.is_captain);

      const benchPoints = bench.reduce(
        (sum: number, p: any) => sum + (live[p.element] ?? 0),
        0
      );

      // Captain miss: the best-scoring starter you didn't captain, minus what
      // your captain actually delivered (single, since armband already doubles).
      let captainMiss = 0;
      if (captain) {
        const capBase = live[captain.element] ?? 0;
        const bestStarter = Math.max(
          0,
          ...starters.map((p: any) => live[p.element] ?? 0)
        );
        captainMiss = Math.max(0, bestStarter - capBase);
      }

      const hits = picks?.entry_history?.event_transfers_cost || 0;

      pointsLeftBehind = {
        total: benchPoints + captainMiss + hits,
        bench: benchPoints,
        captainMiss,
        hits: -hits,
      };
    } catch (e) {
      /* layer 1 optional */
    }

    // ---- Layer 2: your rivals own, you don't ----
    let rivalDiffs: any[] = [];
    try {
      const myPicks = await fplService.getGwPicks(user.fplTeamId, gw);
      const mine = new Set<number>((myPicks?.picks || []).map((p: any) => p.element));

      // Rivals = the entries directly around you in your biggest league's division.
      const myEntry = await prisma.entry.findFirst({
        where: { userId: req.userId, divisionId: { not: null } },
        include: { division: true },
      });

      if (myEntry?.divisionId) {
        const rivals = await prisma.entry.findMany({
          where: {
            divisionId: myEntry.divisionId,
            userId: { not: req.userId },
          },
          include: { user: { select: { fplTeamId: true } } },
          take: 8,
        });

        const own = new Map<number, number>();
        for (const r of rivals) {
          if (!r.user.fplTeamId) continue;
          try {
            const rp = await fplService.getGwPicks(r.user.fplTeamId, gw);
            for (const p of (rp?.picks || []).filter((x: any) => x.multiplier > 0)) {
              if (!mine.has(p.element)) {
                own.set(p.element, (own.get(p.element) || 0) + 1);
              }
            }
          } catch (e) {
            /* skip a rival */
          }
        }

        const boot = await fplService.getBootstrap();
        const teamShort: Record<number, string> = {};
        for (const t of boot.teams || []) teamShort[t.id] = t.short_name;
        const POS: Record<number, string> = { 1: "GK", 2: "DEF", 3: "MID", 4: "FWD" };
        const elMap: Record<number, any> = {};
        for (const e of boot.elements || []) elMap[e.id] = e;

        rivalDiffs = Array.from(own.entries())
          .map(([el, count]) => {
            const e = elMap[el];
            return e
              ? {
                  id: el,
                  name: e.web_name,
                  team: teamShort[e.team] || "",
                  position: POS[e.element_type] || "",
                  rivalsOwn: count,
                  rivalTotal: rivals.length,
                }
              : null;
          })
          .filter(Boolean)
          .sort((a: any, b: any) => b.rivalsOwn - a.rivalsOwn)
          .slice(0, 6);
      }
    } catch (e) {
      /* layer 2 optional */
    }

    // ---- Warning signs: factual red flags on the user's own squad ----
    // No advice, no prediction — just the signals amateurs miss (a flagged /
    // injured player especially). Facts pulled from bootstrap + the user's picks.
    let warnings: any[] = [];
    try {
      const myPicks2 = await fplService.getGwPicks(user.fplTeamId, gw);
      const boot2 = await fplService.getBootstrap();
      const teamShort2: Record<number, string> = {};
      for (const t of boot2.teams || []) teamShort2[t.id] = t.short_name;
      const POS2: Record<number, string> = { 1: "GK", 2: "DEF", 3: "MID", 4: "FWD" };
      const el2: Record<number, any> = {};
      for (const e of boot2.elements || []) el2[e.id] = e;

      for (const p of (myPicks2?.picks || [])) {
        const e = el2[p.element];
        if (!e) continue;
        const flags: string[] = [];
        let severity = 0;

        // Injury / suspension / doubt — the big one beginners miss.
        const chance = e.chance_of_playing_next_round;
        if (e.status && e.status !== "a") {
          if (e.status === "i") { flags.push("Injured"); severity = 3; }
          else if (e.status === "s") { flags.push("Suspended"); severity = 3; }
          else if (e.status === "u") { flags.push("Unavailable"); severity = 3; }
          else if (e.status === "d") {
            flags.push(chance != null ? "Doubtful (" + chance + "%)" : "Doubtful");
            severity = Math.max(severity, 2);
          }
        }
        if (e.news && e.news.trim() && flags.length === 0) {
          flags.push(e.news.trim());
          severity = Math.max(severity, 2);
        }

        // Price falling (has dropped since season start).
        const priceDrop = (e.cost_change_start || 0) < 0;
        if (priceDrop) {
          flags.push("Price falling");
          severity = Math.max(severity, 1);
        }

        // Low recent minutes / not starting.
        if ((e.minutes || 0) > 0 && (e.starts || 0) === 0) {
          flags.push("Not starting");
          severity = Math.max(severity, 2);
        }

        if (flags.length) {
          warnings.push({
            id: p.element,
            name: e.web_name,
            team: teamShort2[e.team] || "",
            position: POS2[e.element_type] || "",
            flags,
            severity,
          });
        }
      }
      warnings.sort((a, b) => b.severity - a.severity);
      warnings = warnings.slice(0, 6);
    } catch (e) {
      /* warnings optional */
    }

    // ---- Layer 3: the in-form 30 (shared, cached only) ----
    // Never compute inline — that's ~60 FPL calls and would block for 15s+.
    // Serve the cached snapshot; if it's missing, kick off a background compute
    // and return null so the screen shows "updating" instead of hanging.
    let inForm: any = null;
    try {
      inForm = await getCachedFormPicks(gw);
    } catch (e) {
      /* layer 3 optional */
    }

    // A simple, honest rating out of 10 from this gameweek vs the user's average.
    let rating: number | null = null;
    try {
      const scores = await prisma.gwScore.findMany({
        where: { entry: { userId: req.userId } },
        select: { gameweek: true, points: true },
      });
      const byGw = new Map<number, number>();
      for (const r of scores) if (!byGw.has(r.gameweek)) byGw.set(r.gameweek, r.points);
      const vals = Array.from(byGw.values());
      if (vals.length) {
        const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
        const thisGw = byGw.get(gw) ?? avg;
        // 5.0 is average; +/- scaled by how far from average, clamped 1-10.
        rating = Math.max(1, Math.min(10, 5 + (thisGw - avg) / 6));
        rating = Math.round(rating * 10) / 10;
      }
    } catch (e) {
      /* rating optional */
    }


    // ---- Chips: yours vs your rivals ----
    // Genuinely valuable and nowhere else: knowing a rival still holds a
    // Wildcard or Bench Boost changes how you play the run-in. Public data,
    // but nobody surfaces it against the people you are actually playing.
    let chips: any = null;
    try {
      const myHist = await fplService.getHistory(user.fplTeamId);
      const myUsed = (myHist?.chips || []).map((c: any) => c.name);
      const ALL_CHIPS = ["wildcard", "bboost", "3xc", "freehit"];
      const LABEL: Record<string, string> = {
        wildcard: "Wildcard", bboost: "Bench Boost",
        "3xc": "Triple Captain", freehit: "Free Hit",
      };

      const rivalChips: Record<string, number> = {};
      let rivalCount = 0;
      const myEntryDiv = await prisma.entry.findFirst({
        where: { userId: req.userId, divisionId: { not: null } },
        select: { divisionId: true },
      });
      if (myEntryDiv?.divisionId) {
        const rivals = await prisma.entry.findMany({
          where: { divisionId: myEntryDiv.divisionId, userId: { not: req.userId } },
          include: { user: { select: { fplTeamId: true } } },
          take: 8,
        });
        for (const r of rivals) {
          if (!r.user.fplTeamId) continue;
          try {
            const h = await fplService.getHistory(r.user.fplTeamId);
            const used = (h?.chips || []).map((c: any) => c.name);
            rivalCount += 1;
            for (const c of ALL_CHIPS) {
              if (!used.includes(c)) rivalChips[c] = (rivalChips[c] || 0) + 1;
            }
          } catch (e) { /* skip */ }
        }
      }

      chips = {
        mine: ALL_CHIPS.map((c) => ({
          key: c, label: LABEL[c], available: !myUsed.includes(c),
        })),
        rivalsHolding: ALL_CHIPS.map((c) => ({
          key: c, label: LABEL[c], count: rivalChips[c] || 0,
        })),
        rivalCount,
      };
    } catch (e) { /* optional */ }

    // ---- Your captain record ----
    // Did the armband pay? Compares what your captain returned against the best
    // score in your own starting XI that week.
    let captaincy: any = null;
    try {
      const rows = await prisma.gwScore.findMany({
        where: { entry: { userId: req.userId }, captainPoints: { gt: 0 } },
        select: { gameweek: true, captainPoints: true, points: true },
        orderBy: { gameweek: "asc" },
      });
      const seen = new Map<number, any>();
      for (const r of rows) if (!seen.has(r.gameweek)) seen.set(r.gameweek, r);
      const list = Array.from(seen.values());
      if (list.length) {
        const total = list.reduce((a, b) => a + (b.captainPoints || 0), 0);
        const best = list.reduce((m, r) =>
          (r.captainPoints || 0) > (m.captainPoints || 0) ? r : m, list[0]);
        const worst = list.reduce((m, r) =>
          (r.captainPoints || 0) < (m.captainPoints || 0) ? r : m, list[0]);
        captaincy = {
          total,
          average: Math.round(total / list.length),
          best: { gameweek: best.gameweek, points: best.captainPoints },
          worst: { gameweek: worst.gameweek, points: worst.captainPoints },
          share: list.length && list.reduce((a, b) => a + b.points, 0) > 0
            ? Math.round((total / list.reduce((a, b) => a + b.points, 0)) * 100)
            : 0,
        };
      }
    } catch (e) { /* optional */ }

    // ---- Head to head record against each rival ----
    // Only Clashd can show this: who you have actually beaten.
    let h2h: any[] = [];
    try {
      const myEntries = await prisma.entry.findMany({
        where: { userId: req.userId },
        select: { id: true },
      });
      const ids = myEntries.map((e) => e.id);
      if (ids.length) {
        const played = await prisma.fixture.findMany({
          where: {
            settled: true,
            OR: [{ homeEntryId: { in: ids } }, { awayEntryId: { in: ids } }],
          },
          include: {
            homeEntry: { include: { user: { select: { displayName: true, fplTeamName: true } } } },
            awayEntry: { include: { user: { select: { displayName: true, fplTeamName: true } } } },
          },
        });
        const rec = new Map<string, any>();
        for (const f of played) {
          const iAmHome = ids.includes(f.homeEntryId);
          const opp = iAmHome ? f.awayEntry : f.homeEntry;
          if (!opp) continue;
          const name = opp.user.fplTeamName || opp.user.displayName;
          const mine = iAmHome ? f.homePoints ?? 0 : f.awayPoints ?? 0;
          const theirs = iAmHome ? f.awayPoints ?? 0 : f.homePoints ?? 0;
          const cur = rec.get(name) || { opponent: name, w: 0, d: 0, l: 0, for: 0, against: 0 };
          if (mine > theirs) cur.w += 1;
          else if (mine < theirs) cur.l += 1;
          else cur.d += 1;
          cur.for += mine;
          cur.against += theirs;
          rec.set(name, cur);
        }
        h2h = Array.from(rec.values())
          .sort((a, b) => (b.w - b.l) - (a.w - a.l))
          .slice(0, 8);
      }
    } catch (e) { /* optional */ }

    // ---- Where you stand in your division, and what is at stake ----
    // The most actionable thing in a fixtures league: are you climbing towards
    // promotion or drifting into the relegation places?
    let stakes: any = null;
    try {
      const myDivEntry = await prisma.entry.findFirst({
        where: { userId: req.userId, divisionId: { not: null } },
        include: { division: true },
      });
      if (myDivEntry?.division) {
        const rows = await prisma.entry.findMany({
          where: { divisionId: myDivEntry.divisionId },
          orderBy: [{ leaguePoints: "desc" }, { totalPoints: "desc" }],
          select: { id: true, leaguePoints: true },
        });
        const total = rows.length;
        const pos = rows.findIndex((r) => r.id === myDivEntry.id) + 1;

        // Two up, two down. Anything within a win of either is worth flagging.
        const PROMO = 2;
        const RELEG = 2;
        const myPts = myDivEntry.leaguePoints;

        const promoLine = rows[PROMO - 1]?.leaguePoints ?? 0;
        const relegLine = rows[Math.max(0, total - RELEG)]?.leaguePoints ?? 0;

        const tiersBelow = await prisma.division.count({
          where: { leagueId: myDivEntry.division.leagueId,
                   cycle: myDivEntry.division.cycle,
                   tier: { gt: myDivEntry.division.tier } },
        });
        const tiersAbove = myDivEntry.division.tier > 1;

        // Gaps to the managers immediately above and below, so the message can
        // be about the actual contest rather than a bare position.
        const aheadPts = pos > 1 ? rows[pos - 2].leaguePoints - myPts : null;
        const behindPts = pos < total ? myPts - rows[pos].leaguePoints : null;

        let state = "mid";
        let message = "";
        if (pos === 1 && !tiersAbove) {
          // Top of the top tier: nothing to be promoted to, but plenty to defend.
          state = "leading";
          message = behindPts != null
            ? (behindPts === 0
                ? `You lead ${myDivEntry.division.name}, level on points with second. `
                  + `Your next fixture could cost you top spot.`
                : `You lead ${myDivEntry.division.name} by `
                  + `${behindPts} point${behindPts === 1 ? "" : "s"}. Keep winning and it stays that way.`)
            : `You lead ${myDivEntry.division.name}.`;
        } else if (pos <= PROMO && tiersAbove) {
          state = "promotion";
          message = `You are ${pos === 1 ? "top" : "in the promotion places"} of `
            + `${myDivEntry.division.name}. Hold this and you go up at the end of the cycle.`;
        } else if (pos <= PROMO && !tiersAbove) {
          state = "chasing";
          message = aheadPts != null && aheadPts > 0
            ? `You are ${pos} of ${total} in ${myDivEntry.division.name}, `
              + `${aheadPts} point${aheadPts === 1 ? "" : "s"} off top. A win closes the gap.`
            : `You are ${pos} of ${total} in ${myDivEntry.division.name}, right in the hunt.`;
        } else if (pos > total - RELEG && tiersBelow > 0) {
          state = "relegation";
          message = `You are in the relegation places in ${myDivEntry.division.name}. `
            + `Your next fixture matters — a win pulls you clear.`;
        } else if (tiersAbove && myPts >= promoLine - 3) {
          state = "chasing";
          message = `You are within a win of the promotion places in `
            + `${myDivEntry.division.name}. Your next fixture could move you up.`;
        } else if (tiersBelow > 0 && myPts <= relegLine + 3) {
          state = "watch";
          message = `You are within a win of the relegation places. Pay attention to your `
            + `next fixture.`;
        } else {
          message = aheadPts != null && aheadPts > 0
            ? `You are ${pos} of ${total} in ${myDivEntry.division.name}, `
              + `${aheadPts} point${aheadPts === 1 ? "" : "s"} off the place above.`
            : `You are ${pos} of ${total} in ${myDivEntry.division.name}.`;
        }

        stakes = {
          division: myDivEntry.division.name,
          position: pos,
          total,
          leaguePoints: myPts,
          state,
          message,
        };
      }
    } catch (e) { /* optional */ }

    // ---- Fixture difficulty: yours, and your rivals' ----
    // FPL publishes a 1-5 difficulty per fixture. On its own that is a free
    // stat. Set against the squads of the managers you are actually drawn
    // with, it becomes something no general FPL site can tell you.
    let fixtureOutlook: any = null;
    try {
      const NEXT = 5;
      const diff = await fplService.teamDifficulty(gw + 1, NEXT);
      const boot3 = await fplService.getBootstrap();
      const elById: Record<number, any> = {};
      for (const e of boot3.elements || []) elById[e.id] = e;

      // Average difficulty facing a manager's starting XI.
      const squadOutlook = async (teamId: number) => {
        const picks = await fplService.getGwPicks(teamId, gw);
        const starters = (picks?.picks || []).filter((p: any) => p.multiplier > 0);
        const vals: number[] = [];
        const perPlayer: any[] = [];
        for (const p of starters) {
          const el = elById[p.element];
          if (!el) continue;
          const d = diff[el.team];
          if (!d || !d.fixtures.length) continue;
          vals.push(d.avg);
          perPlayer.push({
            id: el.id, name: el.web_name, team: d.short,
            avg: d.avg,
            fixtures: d.fixtures.map((f: any) => ({
              gw: f.gw, opponent: f.opponent, home: f.home, difficulty: f.difficulty,
            })),
          });
        }
        const avg = vals.length
          ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10
          : 0;
        return { avg, players: perPlayer };
      };

      const mine = await squadOutlook(user.fplTeamId);

      // The same for the managers in your division.
      const rivals: any[] = [];
      const myDiv = await prisma.entry.findFirst({
        where: { userId: req.userId, divisionId: { not: null } },
        select: { divisionId: true },
      });
      if (myDiv?.divisionId) {
        const others = await prisma.entry.findMany({
          where: { divisionId: myDiv.divisionId, userId: { not: req.userId } },
          include: { user: { select: { fplTeamId: true, displayName: true, fplTeamName: true } } },
          take: 8,
        });
        for (const r of others) {
          if (!r.user.fplTeamId) continue;
          try {
            const o = await squadOutlook(r.user.fplTeamId);
            rivals.push({
              team: r.user.fplTeamName || r.user.displayName,
              avg: o.avg,
            });
          } catch (e) { /* skip a rival we cannot read */ }
        }
      }
      rivals.sort((a, b) => a.avg - b.avg);

      // Where you sit among them: lower average difficulty is a better run.
      const better = rivals.filter((r) => r.avg < mine.avg).length;
      const easiest = [...mine.players].sort((a, b) => a.avg - b.avg).slice(0, 4);
      const hardest = [...mine.players].sort((a, b) => b.avg - a.avg).slice(0, 4);

      fixtureOutlook = {
        gameweeks: NEXT,
        fromGameweek: gw + 1,
        myAverage: mine.avg,
        rivals,
        rankAmongRivals: better + 1,
        totalCompared: rivals.length + 1,
        easiest,
        hardest,
      };
    } catch (e) { /* optional */ }

    // ---- How your players rank, and the market ----
    // Two views of the same public data: your squad measured against the best
    // in each position, and who the best actually are with their fixtures.
    let squadRanking: any = null;
    let market: any = null;
    try {
      const boot4 = await fplService.getBootstrap();
      const POSN: Record<number, string> = { 1: "GK", 2: "DEF", 3: "MID", 4: "FWD" };
      const teamShort4: Record<number, string> = {};
      for (const t of boot4.teams || []) teamShort4[t.id] = t.short_name;

      // The highest season total in each position, which is the 100% mark.
      const best: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
      for (const e of boot4.elements || []) {
        if (e.total_points > (best[e.element_type] || 0)) best[e.element_type] = e.total_points;
      }

      // Your starting XI as a share of the best in their position.
      const myPicks4 = await fplService.getGwPicks(user.fplTeamId, gw);
      const diffMap = await fplService.teamDifficulty(gw + 1, 5).catch(() => ({} as any));
      const elById4: Record<number, any> = {};
      for (const e of boot4.elements || []) elById4[e.id] = e;

      const rows4: any[] = [];
      for (const p of (myPicks4?.picks || [])) {
        const e = elById4[p.element];
        if (!e) continue;
        const ceiling = best[e.element_type] || 1;
        rows4.push({
          id: e.id,
          name: e.web_name,
          team: teamShort4[e.team] || "",
          position: POSN[e.element_type] || "",
          points: e.total_points,
          pct: Math.max(0, Math.min(100, Math.round((e.total_points / ceiling) * 100))),
          starter: p.multiplier > 0,
        });
      }
      rows4.sort((a, b) => b.pct - a.pct);
      squadRanking = { players: rows4, best };

      // Top five in each position, with ownership and the next five fixtures.
      const byPos: Record<string, any[]> = { GK: [], DEF: [], MID: [], FWD: [] };
      const sorted = [...(boot4.elements || [])].sort((a, b) => b.total_points - a.total_points);
      for (const e of sorted) {
        const key = POSN[e.element_type];
        if (!key || byPos[key].length >= 5) continue;
        const d = (diffMap as any)[e.team];
        byPos[key].push({
          id: e.id,
          name: e.web_name,
          team: teamShort4[e.team] || "",
          points: e.total_points,
          ownership: parseFloat(e.selected_by_percent || "0"),
          price: e.now_cost / 10,
          mine: rows4.some((r) => r.id === e.id),
          fixtures: d ? d.fixtures.map((f: any) => ({
            gw: f.gw, opponent: f.opponent, home: f.home, difficulty: f.difficulty,
          })) : [],
        });
      }
      market = byPos;
    } catch (e) { /* optional */ }

    // ---- Dashboard metrics: efficiency, percentile, attribution, form ----
    let dashboard: any = null;
    let lever: any = null;
    try {
      dashboard = await dashboardMetrics(req.userId!, user.fplTeamId, gw);
    } catch (e) { /* optional */ }
    try {
      lever = await biggestLever(req.userId!);
    } catch (e) { /* optional */ }

    // How the top managers and your own division scored this gameweek, so the
    // report can say "you were 7 off the top 40" rather than just your total.
    let benchmarks: any = null;
    try {
      const myDivB = await prisma.entry.findFirst({
        where: { userId: req.userId, divisionId: { not: null } },
        select: { divisionId: true },
      });
      let divisionAvg: number | null = null;
      if (myDivB?.divisionId) {
        const divRows = await prisma.gwScore.findMany({
          where: { gameweek: gw, entry: { divisionId: myDivB.divisionId } },
          select: { points: true },
        });
        divisionAvg = divRows.length
          ? Math.round(divRows.reduce((a, b) => a + b.points, 0) / divRows.length)
          : null;
      }

      // The in-form pack's average, from the cached weekly snapshot.
      let topAvg: number | null = null;
      const snap: any = inForm;
      if (snap && snap.sampleSize) {
        // Their scores are not stored, so use the platform's top decile as a
        // stand-in for "the best are scoring about this".
        const all = await prisma.gwScore.findMany({
          where: { gameweek: gw }, select: { points: true },
          orderBy: { points: "desc" },
        });
        const take = Math.max(1, Math.ceil(all.length * 0.1));
        topAvg = Math.round(
          all.slice(0, take).reduce((a, b) => a + b.points, 0) / take
        );
      }

      benchmarks = { divisionAvg, topAvg };
    } catch (e) { /* optional */ }

    res.json({
      linked: true,
      ready: true,
      gameweek: gw,
      rating,
      pointsLeftBehind,
      rivalDiffs,
      warnings,
      inForm,
      chips,
      captaincy,
      h2h,
      stakes,
      fixtureOutlook,
      squadRanking,
      market,
      dashboard,
      lever,
      benchmarks,
    });
  } catch (e) {
    next(e);
  }
});
