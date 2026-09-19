import { prisma } from "../utils/prisma";
import { fplService } from "./fpl";

/**
 * Dashboard metrics.
 *
 * The things a general FPL site cannot tell you, because it does not hold the
 * field. Clashd has every manager's score, so it can say where you actually
 * sit rather than just what you scored.
 *
 * Everything here is settled fact computed after the event. Nothing predicts.
 */

const VALID_FORMATIONS = [
  { def: 3, mid: 4, fwd: 3 },
  { def: 3, mid: 5, fwd: 2 },
  { def: 4, mid: 3, fwd: 3 },
  { def: 4, mid: 4, fwd: 2 },
  { def: 4, mid: 5, fwd: 1 },
  { def: 5, mid: 2, fwd: 3 },
  { def: 5, mid: 3, fwd: 2 },
  { def: 5, mid: 4, fwd: 1 },
];

/**
 * The best score obtainable from the fifteen a manager already owned, under
 * FPL's formation rules, with the best scorer captained.
 *
 * This is what makes "efficiency" honest: it is not what they could have had
 * with hindsight across all players, only what their own squad could have
 * produced. It separates a bad week from a badly picked week.
 */
export function bestPossibleXI(
  squad: Array<{ element: number; position: number }>,
  points: Record<number, number>,
  elementType: Record<number, number>
) {
  const byPos: Record<number, number[]> = { 1: [], 2: [], 3: [], 4: [] };
  for (const p of squad) {
    const t = elementType[p.element];
    if (!t) continue;
    byPos[t].push(points[p.element] ?? 0);
  }
  for (const k of Object.keys(byPos)) byPos[Number(k)].sort((a, b) => b - a);

  let best = 0;
  for (const f of VALID_FORMATIONS) {
    if (byPos[1].length < 1 || byPos[2].length < f.def) continue;
    if (byPos[3].length < f.mid || byPos[4].length < f.fwd) continue;

    const xi = [
      byPos[1][0],
      ...byPos[2].slice(0, f.def),
      ...byPos[3].slice(0, f.mid),
      ...byPos[4].slice(0, f.fwd),
    ];
    // Captain the highest scorer in that XI.
    const total = xi.reduce((a, b) => a + b, 0) + Math.max(...xi);
    if (total > best) best = total;
  }
  return best;
}

/**
 * Everything the Overview scorecard and the Gameweek report need.
 */
export async function dashboardMetrics(userId: string, fplTeamId: number, gw: number) {
  const out: any = {};

  // ---- The field: every Clashd score this gameweek ----
  const fieldRows = await prisma.gwScore.findMany({
    where: { gameweek: gw },
    select: { entryId: true, points: true, entry: { select: { userId: true } } },
  });
  // One score per manager, not per league entry.
  const byUser = new Map<string, number>();
  for (const r of fieldRows) {
    if (!byUser.has(r.entry.userId)) byUser.set(r.entry.userId, r.points);
  }
  const field = Array.from(byUser.values()).sort((a, b) => a - b);
  const myScore = byUser.get(userId) ?? 0;

  if (field.length) {
    const below = field.filter((v) => v < myScore).length;
    out.percentile = Math.round((below / field.length) * 100);
    out.field = {
      lowest: field[0],
      highest: field[field.length - 1],
      average: Math.round(field.reduce((a, b) => a + b, 0) / field.length),
      managers: field.length,
      myScore,
    };
  }

  // ---- Efficiency: actual against the best your own fifteen could give ----
  try {
    const picks = await fplService.getGwPicks(fplTeamId, gw);
    const live = await fplService.getLiveGwPoints(gw);
    const boot = await fplService.getBootstrap();
    const elType: Record<number, number> = {};
    const elName: Record<number, string> = {};
    for (const e of boot.elements || []) {
      elType[e.id] = e.element_type;
      elName[e.id] = e.web_name;
    }

    const squad = (picks?.picks || []).map((p: any) => ({
      element: p.element, position: p.position,
    }));
    const hits = picks?.entry_history?.event_transfers_cost || 0;

    const actual = (picks?.picks || [])
      .filter((p: any) => p.multiplier > 0)
      .reduce((sum: number, p: any) => sum + (live[p.element] ?? 0) * p.multiplier, 0);

    const possible = bestPossibleXI(squad, live, elType);
    out.efficiency = {
      actual,
      possible,
      pct: possible > 0 ? Math.round((actual / possible) * 100) : 0,
      hits,
    };

    // ---- Where the points came from ----
    const POS: Record<number, string> = { 1: "GK", 2: "DEF", 3: "MID", 4: "FWD" };
    const attribution: Record<string, number> = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
    for (const p of (picks?.picks || []).filter((x: any) => x.multiplier > 0)) {
      const key = POS[elType[p.element]];
      if (key) attribution[key] += (live[p.element] ?? 0) * p.multiplier;
    }
    out.attribution = attribution;

    // ---- The call that decided the week ----
    const bench = (picks?.picks || []).filter((p: any) => p.multiplier === 0);
    let worstBench = { name: "", points: 0 };
    for (const b of bench) {
      const pts = live[b.element] ?? 0;
      if (pts > worstBench.points) worstBench = { name: elName[b.element] || "", points: pts };
    }

    const starters = (picks?.picks || []).filter((p: any) => p.multiplier > 0);
    const captain = starters.find((p: any) => p.is_captain);
    const capBase = captain ? (live[captain.element] ?? 0) : 0;
    const bestStarter = starters.length
      ? Math.max(...starters.map((p: any) => live[p.element] ?? 0))
      : 0;
    const captainMiss = Math.max(0, bestStarter - capBase);

    const candidates = [
      { kind: "bench", cost: worstBench.points, who: worstBench.name },
      { kind: "captain", cost: captainMiss, who: "" },
      { kind: "hits", cost: hits, who: "" },
    ].sort((a, b) => b.cost - a.cost);

    const top = candidates[0];
    if (top && top.cost > 0) {
      out.decisiveCall = {
        kind: top.kind,
        cost: top.cost,
        who: top.who,
        message:
          top.kind === "bench"
            ? `Benching ${top.who} cost you ${top.cost}.`
            : top.kind === "captain"
            ? `Your armband was worth ${top.cost} less than your best starter.`
            : `Your transfer hit cost you ${top.cost}.`,
      };
    }

    out.leftBehind = {
      bench: bench.reduce((s: number, b: any) => s + (live[b.element] ?? 0), 0),
      captainMiss,
      hits,
    };
  } catch (e) {
    /* FPL unavailable — the rest still works */
  }

  // ---- Form: your last six gameweeks against the platform average ----
  try {
    const from = Math.max(1, gw - 5);
    const rows = await prisma.gwScore.findMany({
      where: { gameweek: { gte: from, lte: gw } },
      select: { gameweek: true, points: true, entry: { select: { userId: true } } },
    });

    const mineByGw = new Map<number, number>();
    const allByGw = new Map<number, number[]>();
    const seen = new Set<string>();
    for (const r of rows) {
      const key = r.entry.userId + ":" + r.gameweek;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!allByGw.has(r.gameweek)) allByGw.set(r.gameweek, []);
      allByGw.get(r.gameweek)!.push(r.points);
      if (r.entry.userId === userId) mineByGw.set(r.gameweek, r.points);
    }

    const form: any[] = [];
    for (let g = from; g <= gw; g++) {
      const all = allByGw.get(g) || [];
      const avg = all.length ? Math.round(all.reduce((a, b) => a + b, 0) / all.length) : 0;
      form.push({
        gameweek: g,
        points: mineByGw.get(g) ?? null,
        average: avg,
        aboveAverage: (mineByGw.get(g) ?? 0) >= avg,
      });
    }
    out.form = form;
  } catch (e) { /* optional */ }

  // ---- Consistency and season rate ----
  try {
    const mine = await prisma.gwScore.findMany({
      where: { entry: { userId } },
      select: { gameweek: true, points: true },
    });
    const uniq = new Map<number, number>();
    for (const r of mine) if (!uniq.has(r.gameweek)) uniq.set(r.gameweek, r.points);
    const vals = Array.from(uniq.values());
    if (vals.length >= 2) {
      const hi = Math.max(...vals);
      const lo = Math.min(...vals);
      const rate = vals.reduce((a, b) => a + b, 0) / vals.length;
      out.consistency = {
        swing: hi - lo,
        best: hi,
        worst: lo,
        rate: Math.round(rate * 10) / 10,
        // A smaller swing relative to the average is steadier.
        label: hi - lo <= 25 ? "High" : hi - lo <= 40 ? "Moderate" : "Volatile",
      };
    }
  } catch (e) { /* optional */ }

  return out;
}

/**
 * The single biggest thing costing a manager across the season, set against
 * their division. This is the line that should change behaviour.
 */
export async function biggestLever(userId: string) {
  const mine = await prisma.gwScore.findMany({
    where: { entry: { userId } },
    select: { gameweek: true, pointsOnBench: true },
  });
  const uniq = new Map<number, number>();
  for (const r of mine) if (!uniq.has(r.gameweek)) uniq.set(r.gameweek, r.pointsOnBench);
  const benchTotal = Array.from(uniq.values()).reduce((a, b) => a + b, 0);
  if (!benchTotal) return null;

  // How that compares with the managers in the same division.
  const myEntry = await prisma.entry.findFirst({
    where: { userId, divisionId: { not: null } },
    select: { divisionId: true },
  });

  let rank: number | null = null;
  let total: number | null = null;
  if (myEntry?.divisionId) {
    const others = await prisma.entry.findMany({
      where: { divisionId: myEntry.divisionId },
      select: { userId: true },
    });
    const totals: number[] = [];
    for (const o of others) {
      const rows = await prisma.gwScore.findMany({
        where: { entry: { userId: o.userId } },
        select: { gameweek: true, pointsOnBench: true },
      });
      const u = new Map<number, number>();
      for (const r of rows) if (!u.has(r.gameweek)) u.set(r.gameweek, r.pointsOnBench);
      totals.push(Array.from(u.values()).reduce((a, b) => a + b, 0));
    }
    totals.sort((a, b) => b - a);
    rank = totals.indexOf(benchTotal) + 1;
    total = totals.length;
  }

  return {
    benchTotal,
    rankInDivision: rank,
    divisionSize: total,
    message:
      rank === 1 && total && total > 1
        ? `You have left ${benchTotal} points on your bench, more than anyone in your division.`
        : `You have left ${benchTotal} points on your bench this season.`,
  };
}
