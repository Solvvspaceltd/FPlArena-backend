import { Router } from "express";
import { prisma } from "../utils/prisma";
import { authenticate, AuthRequest } from "../middleware/authenticate";
import { fplService } from "../services/fpl";
import { getCachedFormPicks } from "../jobs/formPicks";

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

        let state = "mid";
        let message = "";
        if (pos <= PROMO && tiersAbove) {
          state = "promotion";
          message = `You are ${pos === 1 ? "top" : "in the promotion places"} of `
            + `${myDivEntry.division.name}. Hold this and you go up at the end of the cycle.`;
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
          message = `You are ${pos} of ${total} in ${myDivEntry.division.name}.`;
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
    });
  } catch (e) {
    next(e);
  }
});
