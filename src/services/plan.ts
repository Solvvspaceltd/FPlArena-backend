import { prisma } from "../utils/prisma";
import { fplService } from "./fpl";
import {
  getProjections, saveForecastSnapshot, getRecord, bestXI, phi,
  Projections, PlayerForecast,
} from "./projections";

/**
 * Plan ahead: everything the Analysis tab shows before a deadline.
 *
 * Built on the forecasting engine, but every section is pointed at the
 * people the user actually plays: the match against this week's opponent,
 * captains ranked by what they do against that opponent, transfers weighed
 * by who in the division already owns the player, chips beside rivals' chips.
 *
 * Squads come from the last deadline, because FPL only publishes picks once
 * a deadline has passed. Transfers made this week show after the next one.
 */

const CHIP_KEYS = ["wildcard", "bboost", "3xc", "freehit"];
const CHIP_LABEL: Record<string, string> = {
  wildcard: "Wildcard", bboost: "Bench Boost", "3xc": "Triple Captain", freehit: "Free Hit",
};
const half = (gw: number) => (gw <= 19 ? 1 : 2);

type Pick = { element: number; position: number; multiplier: number; is_captain: boolean };

type Side = {
  name: string;
  teamId: number;
  picks: Pick[];
  bank: number;
  history: any | null;
};

const planCache = new Map<string, { at: number; data: any }>();
const PLAN_TTL_MS = 5 * 60 * 1000;

function round1(v: number) { return Math.round(v * 10) / 10; }

function fixtureLabel(p: PlayerForecast, i = 0) {
  const list = p.fixtures[i] || [];
  if (!list.length) return "No fixture";
  return list.map((f) => `${f.opp} (${f.home ? "H" : "A"})`).join(", ");
}

/** Multiplier each player carries in a squad, for the forecast. */
function multipliers(picks: Pick[]) {
  const m = new Map<number, number>();
  for (const p of picks) {
    if (p.position > 11) { m.set(p.element, 0); continue; }
    m.set(p.element, p.is_captain ? 2 : 1);
  }
  return m;
}

/** Free transfers for the coming gameweek, estimated from the public history. */
function estimateFreeTransfers(history: any, nextGw: number) {
  const current: any[] = (history?.current || []).slice().sort((a: any, b: any) => a.event - b.event);
  const chipAt = new Map<number, string>();
  for (const c of history?.chips || []) chipAt.set(c.event, c.name);
  let ft = 1;
  for (const row of current) {
    if (row.event <= 1 || row.event >= nextGw) continue;
    const chip = chipAt.get(row.event);
    if (chip === "wildcard" || chip === "freehit") {
      ft = Math.min(5, ft + 1);
      continue;
    }
    ft = Math.min(5, Math.max(0, ft - (row.event_transfers || 0)) + 1);
  }
  return Math.max(1, ft);
}

function chipsHeld(history: any, gw: number) {
  const used = (history?.chips || []).filter((c: any) => half(c.event) === half(gw)).map((c: any) => c.name);
  const out: Record<string, boolean> = {};
  for (const k of CHIP_KEYS) out[k] = !used.includes(k);
  return out;
}

async function loadPicks(teamId: number, gw: number): Promise<{ picks: Pick[]; bank: number } | null> {
  let data = await fplService.getGwPicks(teamId, gw).catch(() => null);
  // A Free Hit squad reverts after one week, so read the squad before it.
  if (data?.active_chip === "freehit" && gw > 1) {
    const prev = await fplService.getGwPicks(teamId, gw - 1).catch(() => null);
    if (prev) data = { ...prev, entry_history: data.entry_history };
  }
  if (!data?.picks) return null;
  return {
    picks: data.picks.map((p: any) => ({
      element: p.element, position: p.position, multiplier: p.multiplier, is_captain: !!p.is_captain,
    })),
    bank: (data.entry_history?.bank || 0) / 10,
  };
}

function sideTotal(side: Side, proj: Projections, i = 0) {
  let t = 0;
  for (const p of side.picks) {
    if (p.position > 11) continue;
    const f = proj.players[p.element];
    if (!f) continue;
    t += f.xp[i] * (p.is_captain ? 2 : 1);
  }
  return t;
}

/** The match against this week's opponent. */
function buildMatch(me: Side, opp: Side, proj: Projections) {
  const mm = multipliers(me.picks);
  const tm = multipliers(opp.picks);
  const ids = new Set<number>([...me.picks.map((p) => p.element), ...opp.picks.map((p) => p.element)]);

  let meTotal = 0; let themTotal = 0; let variance = 0; let sharedBase = 0;
  const shared: any[] = [];
  const mine: any[] = [];
  const theirs: any[] = [];
  for (const id of ids) {
    const f = proj.players[id];
    if (!f) continue;
    const a = mm.get(id) || 0;
    const b = tm.get(id) || 0;
    meTotal += f.next * a;
    themTotal += f.next * b;
    variance += f.variance * (a - b) * (a - b);
    if (a > 0 && b > 0) {
      shared.push({ name: f.name, xp: round1(f.next) });
      sharedBase += f.next;
    }
    const row = { id, name: f.name, team: f.teamShort, fixture: fixtureLabel(f), captain: false, xp: 0 };
    if (a > 0 && b === 0) mine.push({ ...row, captain: a > 1, xp: round1(f.next * a) });
    if (b > 0 && a === 0) theirs.push({ ...row, captain: b > 1, xp: round1(f.next * b) });
  }
  mine.sort((x, y) => y.xp - x.xp);
  theirs.sort((x, y) => y.xp - x.xp);
  shared.sort((x, y) => y.xp - x.xp);

  const sd = Math.sqrt(Math.max(variance, 4));
  const winChance = Math.round(phi((meTotal - themTotal) / sd) * 100);

  let verdict = "";
  let detail = "";
  const a = mine[0];
  const b = theirs[0];
  if (a && b) {
    verdict = `Your match comes down to ${a.name} against ${b.name}.`;
    const rest = (meTotal - a.xp) - (themTotal - b.xp);
    if (rest >= 0) {
      detail = `Even if ${b.name} edges ${a.name}, the rest of your team is forecast to carry it.`;
    } else {
      const need = Math.ceil(-rest);
      detail = `${a.name} plays ${a.fixture}. If he outscores ${b.name} by ${need} or more, the match is yours.`;
    }
  } else if (a) {
    verdict = `${a.name} is your edge. They have nothing you do not.`;
    detail = "Everything they own, you own. Your differentials decide it.";
  } else if (b) {
    verdict = `${b.name} is their edge. You own everything else they have.`;
    detail = "Your captain is the only way to swing it back.";
  } else {
    verdict = "Identical starting elevens. Captaincy decides this one.";
  }

  const myCap = me.picks.find((p) => p.is_captain);
  const theirCap = opp.picks.find((p) => p.is_captain);

  return {
    opponent: opp.name,
    me: round1(meTotal),
    them: round1(themTotal),
    winChance,
    sharedCount: shared.length,
    sharedXp: round1(sharedBase),
    shared: shared.slice(0, 11),
    youPlus: round1(meTotal - sharedBase),
    themPlus: round1(themTotal - sharedBase),
    mine: mine.slice(0, 6),
    theirs: theirs.slice(0, 6),
    verdict,
    detail,
    myCaptain: myCap ? proj.players[myCap.element]?.name || null : null,
    theirCaptain: theirCap ? proj.players[theirCap.element]?.name || null : null,
    theirCaptainId: theirCap?.element || null,
  };
}

export async function buildPlan(userId: string, opts: { fresh?: boolean } = {}) {
  const hit = planCache.get(userId);
  if (!opts.fresh && hit && Date.now() - hit.at < PLAN_TTL_MS) return hit.data;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { fplTeamId: true, fplTeamName: true, displayName: true },
  });
  if (!user?.fplTeamId) return { linked: false };

  const proj = await getProjections();
  saveForecastSnapshot(proj).catch(() => null);
  const nextGw = proj.fromGw;
  const next = await fplService.getNextGameweek();
  const srcGw = nextGw - 1;
  if (srcGw < 1) return { linked: true, ready: false, reason: "The season has not started." };

  // ---- Me ----
  const [myPicks, myHistory] = await Promise.all([
    loadPicks(user.fplTeamId, srcGw),
    fplService.getHistory(user.fplTeamId).catch(() => null),
  ]);
  if (!myPicks) return { linked: true, ready: false, reason: "Your squad is not available from FPL yet." };
  const me: Side = {
    name: user.fplTeamName || user.displayName, teamId: user.fplTeamId,
    picks: myPicks.picks, bank: myPicks.bank, history: myHistory,
  };

  // ---- Division rivals ----
  const myDivEntry = await prisma.entry.findFirst({
    where: { userId, divisionId: { not: null } },
    select: { id: true, divisionId: true },
  });
  const rivalRows = myDivEntry?.divisionId
    ? await prisma.entry.findMany({
        where: { divisionId: myDivEntry.divisionId, userId: { not: userId } },
        include: { user: { select: { fplTeamId: true, fplTeamName: true, displayName: true } } },
        take: 12,
      })
    : [];
  const rivals: Side[] = (await Promise.all(rivalRows
    .filter((r) => r.user.fplTeamId)
    .map(async (r) => {
      const [pk, h] = await Promise.all([
        loadPicks(r.user.fplTeamId!, srcGw),
        fplService.getHistory(r.user.fplTeamId!).catch(() => null),
      ]);
      if (!pk) return null;
      return {
        name: r.user.fplTeamName || r.user.displayName, teamId: r.user.fplTeamId!,
        picks: pk.picks, bank: pk.bank, history: h,
      } as Side;
    }))).filter(Boolean) as Side[];

  // ---- This week's opponent ----
  let opp: Side | null = null;
  const myEntries = await prisma.entry.findMany({ where: { userId }, select: { id: true } });
  const myIds = myEntries.map((e) => e.id);
  if (myIds.length) {
    const fx = await prisma.fixture.findFirst({
      where: {
        settled: false,
        gameweek: { gte: nextGw },
        OR: [{ homeEntryId: { in: myIds } }, { awayEntryId: { in: myIds } }],
      },
      orderBy: { gameweek: "asc" },
      include: {
        homeEntry: { include: { user: { select: { fplTeamId: true, fplTeamName: true, displayName: true } } } },
        awayEntry: { include: { user: { select: { fplTeamId: true, fplTeamName: true, displayName: true } } } },
      },
    });
    if (fx) {
      const oppEntry = myIds.includes(fx.homeEntryId) ? fx.awayEntry : fx.homeEntry;
      const oppTeamId = oppEntry?.user.fplTeamId;
      if (oppEntry && oppTeamId) {
        opp = rivals.find((r) => r.teamId === oppTeamId) || null;
        if (!opp) {
          const [pk, h] = await Promise.all([
            loadPicks(oppTeamId, srcGw),
            fplService.getHistory(oppTeamId).catch(() => null),
          ]);
          if (pk) {
            opp = {
              name: oppEntry.user.fplTeamName || oppEntry.user.displayName, teamId: oppTeamId,
              picks: pk.picks, bank: pk.bank, history: h,
            };
          }
        }
      }
    }
  }

  const P = (id: number) => proj.players[id];
  const mySquadIds = me.picks.map((p) => p.element);
  const myStarters = me.picks.filter((p) => p.position <= 11).map((p) => p.element);

  // ---- Match ----
  const match = opp ? buildMatch(me, opp, proj) : null;

  // Opponent's captaincy habit over the last five gameweeks.
  if (match && opp) {
    try {
      const gws = [srcGw, srcGw - 1, srcGw - 2, srcGw - 3, srcGw - 4].filter((g) => g >= 1);
      const caps = await Promise.all(gws.map((g) => fplService.getGwPicks(opp!.teamId, g).catch(() => null)));
      const capIds = caps.map((c: any) => c?.picks?.find((p: any) => p.is_captain)?.element).filter(Boolean);
      const top = new Map<number, number>();
      for (const id of capIds) top.set(id, (top.get(id) || 0) + 1);
      const fav = Array.from(top.entries()).sort((a, b) => b[1] - a[1])[0];
      (match as any).captainHabit = fav
        ? { name: P(fav[0])?.name || "", times: fav[1], of: capIds.length }
        : null;
    } catch (e) { /* optional */ }
  }

  // ---- Captain ----
  const oppMult = opp ? multipliers(opp.picks) : new Map<number, number>();
  const capList = myStarters
    .map((id) => P(id)).filter(Boolean)
    .sort((a, b) => b.next - a.next)
    .slice(0, 5)
    .map((f) => {
      const theirs = oppMult.get(f.id) || 0;
      const edge = round1(f.next * (2 - theirs));
      let tag: string | null = null;
      let why = "";
      if (opp) {
        if (theirs >= 2) { tag = "SAFE"; why = "Matches their captain. If he hauls, you both gain."; }
        else if (theirs === 1) { tag = "PART"; why = "They own him but not as captain. You gain one extra share."; }
        else { tag = "GAIN"; why = "They do not own him. Every point is a point on them."; }
      }
      return {
        id: f.id, name: f.name, team: f.teamShort, fixture: fixtureLabel(f),
        xp: round1(f.next * 2), haul: Math.round(f.haul * 100), tag, why, edge,
      };
    });

  let capPick: any = capList[0] || null;
  let capReason = capPick ? "Highest forecast in your starting eleven." : "";
  let capAlt: string | null = null;
  if (match && capList.length) {
    const topXp = capList[0].xp;
    const safe = capList.find((c) => c.tag === "SAFE" && c.xp >= topXp * 0.8);
    const gain = capList.filter((c) => c.xp >= topXp * 0.75).sort((a, b) => b.edge - a.edge)[0];
    if (match.winChance >= 55) {
      capPick = safe || capList[0];
      capReason = `You lead this match on forecast. Leaders protect: if ${capPick.name} hauls, your lead holds.`;
      if (gain && gain.name !== capPick.name) capAlt = `If you were chasing, the pick would be ${gain.name}.`;
    } else if (match.winChance <= 45) {
      capPick = gain || capList[0];
      capReason = capPick.tag === "GAIN"
        ? `You trail on forecast. ${capPick.name} is the pick that can swing it: they do not own him.`
        : `You trail on forecast. ${capPick.name} gives you the biggest edge on them.`;
      if (safe && safe.name !== capPick.name) capAlt = `If you were leading, the safe pick would be ${safe.name}.`;
    } else {
      capPick = capList[0];
      capReason = `This match is too close to call. Take the highest forecast: ${capPick.name}.`;
    }
  }

  // Last week's armbands across the division.
  const armbands = new Map<number, number>();
  for (const s of [me, ...rivals]) {
    const c = s.picks.find((p) => p.is_captain);
    if (c) armbands.set(c.element, (armbands.get(c.element) || 0) + 1);
  }
  const armbandList = Array.from(armbands.entries())
    .sort((a, b) => b[1] - a[1]).slice(0, 4)
    .map(([id, count]) => ({ name: P(id)?.name || "", count }));

  // ---- Transfers ----
  const rivalOwn = new Map<number, number>();
  for (const r of rivals) for (const p of r.picks) rivalOwn.set(p.element, (rivalOwn.get(p.element) || 0) + 1);
  const H5 = Math.min(5, proj.horizon);
  const xp5 = (f: PlayerForecast) => f.xp.slice(0, H5).reduce((a, b) => a + b, 0);
  const clubCount = new Map<number, number>();
  for (const id of mySquadIds) { const f = P(id); if (f) clubCount.set(f.team, (clubCount.get(f.team) || 0) + 1); }
  const freeTransfers = estimateFreeTransfers(me.history, nextGw);
  const starterSet = new Set(myStarters);
  const all = Object.values(proj.players);

  function bestMove(exclude: Set<number>, bank: number) {
    let best: any = null;
    for (const outId of mySquadIds) {
      if (exclude.has(outId)) continue;
      const out = P(outId);
      if (!out) continue;
      const budget = out.price + bank;
      const w = starterSet.has(outId) ? 1 : 0.35;
      for (const cand of all) {
        if (cand.pos !== out.pos || mySquadIds.includes(cand.id) || exclude.has(cand.id)) continue;
        if (cand.price > budget + 1e-9) continue;
        if (cand.status === "u" || cand.status === "n") continue;
        const clubAfter = (clubCount.get(cand.team) || 0) - (out.team === cand.team ? 1 : 0);
        if (clubAfter >= 3) continue;
        const gain = (xp5(cand) - xp5(out)) * w;
        if (!best || gain > best.gain) {
          best = { outId, inId: cand.id, gain, cost: cand.price - out.price };
        }
      }
    }
    if (!best) return null;
    const o = P(best.outId); const n = P(best.inId);
    return {
      out: { id: o.id, name: o.name, team: o.teamShort, price: o.price },
      in: { id: n.id, name: n.name, team: n.teamShort, price: n.price },
      gain: round1(best.gain),
      rivalsOwn: rivalOwn.get(n.id) || 0,
      cost: round1(best.cost),
      _out: best.outId, _in: best.inId,
    };
  }
  const move1 = bestMove(new Set(), me.bank);
  let move2: any = null;
  if (move1) {
    move2 = bestMove(new Set([move1._out, move1._in]), me.bank - move1.cost);
  }
  let hitVerdict = "";
  let hitWorth = false;
  if (move2) {
    if (freeTransfers >= 2) {
      hitVerdict = `You have ${freeTransfers} free transfers. ${move2.out.name} to ${move2.in.name} adds ${move2.gain} more at no cost.`;
      hitWorth = true;
    } else if (move2.gain > 4) {
      hitVerdict = `Yes. ${move2.out.name} to ${move2.in.name} gains ${move2.gain} over five gameweeks, more than the 4 it costs.`;
      hitWorth = true;
    } else {
      hitVerdict = `No. The next best move, ${move2.out.name} to ${move2.in.name}, gains ${move2.gain} over five gameweeks. The hit costs 4.`;
    }
  }
  const rivalCount = rivals.length;
  const maxSpend: Record<number, number> = {};
  for (const id of mySquadIds) {
    const f = P(id); if (!f) continue;
    maxSpend[f.pos] = Math.max(maxSpend[f.pos] || 0, round1(f.price + me.bank));
  }
  const targets: Record<string, any[]> = {};
  for (const [pos, key] of [[1, "GK"], [2, "DEF"], [3, "MID"], [4, "FWD"]] as [number, string][]) {
    targets[key] = all
      .filter((f) => f.pos === pos && f.status !== "u" && f.status !== "n")
      .sort((a, b) => xp5(b) - xp5(a))
      .slice(0, 12)
      .map((f) => ({
        id: f.id, name: f.name, team: f.teamShort, price: f.price, xp: round1(xp5(f)),
        rivalsOwn: rivalOwn.get(f.id) || 0, mine: mySquadIds.includes(f.id), owned: f.owned,
        fixtures: f.fixtures.slice(0, H5).map((l) => l[0]
          ? { opp: l[0].opp, home: l[0].home, difficulty: l[0].difficulty, double: l.length > 1 }
          : null),
      }));
  }

  // ---- Chips ----
  const inHalf: number[] = [];
  for (let i = 0; i < proj.horizon; i++) if (half(nextGw + i) === half(nextGw)) inHalf.push(i);
  const xiTotals = inHalf.map((i) => bestXI(mySquadIds, proj, i).reduce((a, f) => a + f.xp[i], 0));
  const benchTotals = inHalf.map((i) => {
    const xi = new Set(bestXI(mySquadIds, proj, i).map((f) => f.id));
    return mySquadIds.filter((id) => !xi.has(id)).reduce((a, id) => a + (P(id)?.xp[i] || 0), 0);
  });
  const tcBest = inHalf.map((i) => {
    const xi = bestXI(mySquadIds, proj, i).sort((a, b) => b.xp[i] - a.xp[i]);
    return { i, name: xi[0]?.name || "", xp: xi[0]?.xp[i] || 0, fixture: xi[0] ? fixtureLabel(xi[0], i) : "" };
  });
  const held = chipsHeld(me.history, nextGw);
  const argmax = (arr: number[]) => arr.reduce((b, v, i) => (v > arr[b] ? i : b), 0);
  const argmin = (arr: number[]) => arr.reduce((b, v, i) => (v < arr[b] ? i : b), 0);
  const avgXi = xiTotals.length ? xiTotals.reduce((a, b) => a + b, 0) / xiTotals.length : 0;

  // Squad outlook ranks are needed for the Wildcard line, so compute them here.
  const horizonTotal = (ids: number[]) => {
    let t = 0;
    for (let i = 0; i < proj.horizon; i++) t += bestXI(ids, proj, i).reduce((a, f) => a + f.xp[i], 0);
    return t;
  };
  const table = [
    { name: me.name, me: true, total: horizonTotal(mySquadIds) },
    ...rivals.map((r) => ({ name: r.name, me: false, total: horizonTotal(r.picks.map((p) => p.element)) })),
  ].sort((a, b) => b.total - a.total);
  const myRank = table.findIndex((t) => t.me) + 1;
  const topTotal = table[0]?.total || 1;
  const myTotal = table.find((t) => t.me)?.total || 0;

  const chipRows: any[] = [];
  if (inHalf.length) {
    const bi = argmax(benchTotals);
    chipRows.push({
      key: "bboost", label: CHIP_LABEL.bboost, available: held.bboost,
      gameweek: nextGw + inHalf[bi], gain: round1(benchTotals[bi]),
      why: `Your bench is forecast ${round1(benchTotals[bi])} that week, its best in the next ${inHalf.length}.`,
    });
    const ti = tcBest.reduce((b, v, i) => (v.xp > tcBest[b].xp ? i : b), 0);
    chipRows.push({
      key: "3xc", label: CHIP_LABEL["3xc"], available: held["3xc"],
      gameweek: nextGw + tcBest[ti].i, gain: round1(tcBest[ti].xp),
      why: `${tcBest[ti].name}, ${tcBest[ti].fixture}. Your single best forecast.`,
    });
    const wi = argmin(xiTotals);
    chipRows.push({
      key: "freehit", label: CHIP_LABEL.freehit, available: held.freehit,
      gameweek: nextGw + inHalf[wi], gain: round1(avgXi - xiTotals[wi]),
      why: `Your weakest week: forecast ${round1(xiTotals[wi])} against your average of ${round1(avgXi)}.`,
    });
    const topHalf = myRank <= Math.ceil(table.length / 2);
    chipRows.push({
      key: "wildcard", label: CHIP_LABEL.wildcard, available: held.wildcard,
      gameweek: null, gain: null,
      why: topHalf
        ? `Hold. Your squad ranks ${myRank} of ${table.length} in your division over the next six.`
        : `Worth considering. Your squad ranks ${myRank} of ${table.length} in your division over the next six.`,
    });
  }
  const rivalChips = [...(opp && !rivals.find((r) => r.teamId === opp!.teamId) ? [opp] : []), ...rivals]
    .map((r) => ({ name: r.name, held: chipsHeld(r.history, nextGw), opponent: !!opp && r.teamId === opp.teamId }));
  const bbHolders = rivalChips.filter((r) => r.held.bboost).length;
  const rivalBench = rivals.length
    ? rivals.reduce((a, r) => a + r.picks.filter((p) => p.position > 11).reduce((s, p) => s + (P(p.element)?.next || 0), 0), 0) / rivals.length
    : 0;
  const chipRisk = bbHolders > 0
    ? {
        title: `${bbHolders} rival${bbHolders === 1 ? "" : "s"} still hold${bbHolders === 1 ? "s" : ""} Bench Boost.`,
        detail: `A rival's bench is forecast about ${round1(rivalBench)} points a week. Playing yours in the same week cancels it out.`,
      }
    : null;

  // ---- Squad outlook ----
  const score = Math.round((myTotal / topTotal) * 100);
  const squadPlayers = mySquadIds
    .map((id) => P(id)).filter(Boolean)
    .sort((a, b) => b.total - a.total)
    .map((f) => ({ id: f.id, name: f.name, team: f.teamShort, xp: round1(f.total), starter: starterSet.has(f.id), status: f.status }));
  const maxPlayer = squadPlayers[0]?.xp || 1;
  for (const p of squadPlayers as any[]) p.pct = Math.round((p.xp / maxPlayer) * 100);
  const weakest = squadPlayers.filter((p) => p.starter).slice(-1)[0] || null;
  const ahead = table.filter((t) => !t.me && t.total > myTotal).map((t) => t.name);

  let fixtureRun: any = null;
  try {
    const diff = await fplService.teamDifficulty(nextGw, 5);
    const avgDiff = (ids: number[]) => {
      const v = ids.map((id) => diff[P(id)?.team || 0]?.avg || 0).filter((x) => x > 0);
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
    };
    const mine = avgDiff(myStarters);
    const others = rivals.map((r) => avgDiff(r.picks.filter((p) => p.position <= 11).map((p) => p.element)));
    const easier = others.filter((o) => mine < o).length;
    const byRun = myStarters.map((id) => P(id)).filter(Boolean)
      .map((f) => ({ name: f.name, avg: diff[f.team]?.avg || 3 }))
      .sort((a, b) => a.avg - b.avg);
    fixtureRun = {
      easierThan: easier, rivals: others.length,
      best: byRun.slice(0, 2).map((x) => x.name),
      worst: byRun.slice(-2).map((x) => x.name),
    };
  } catch (e) { /* optional */ }

  // ---- Record ----
  let record: any = null;
  try {
    record = await getRecord(srcGw);
    if (!record && srcGw > 1) record = await getRecord(srcGw - 1);
  } catch (e) { /* optional */ }

  const data = {
    linked: true,
    ready: true,
    gameweek: nextGw,
    deadline: next?.deadline || null,
    squadFrom: srcGw,
    match,
    captain: { pick: capPick, reason: capReason, alt: capAlt, list: capList, armbands: armbandList, divisionSize: rivals.length + 1 },
    transfers: {
      bank: round1(me.bank), freeTransfers, best: move1, second: move2, hitVerdict, hitWorth,
      targets, maxSpend, rivals: rivalCount,
    },
    chips: { mine: chipRows, rivals: rivalChips, risk: chipRisk, half: half(nextGw) },
    squad: {
      score, rank: myRank, of: table.length, ahead,
      players: squadPlayers, weakest, fixtureRun,
    },
    record,
  };
  planCache.set(userId, { at: Date.now(), data });
  return data;
}

/** The Home deadline card: the match forecast and one line on last week. */
export async function buildHomeCard(userId: string) {
  const plan: any = await buildPlan(userId);
  if (!plan?.ready) return { ready: false };
  let lastLine: string | null = null;
  try {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { fplTeamId: true } });
    const cur = await fplService.getCurrentGameweek();
    if (user?.fplTeamId && cur) {
      const done = await fplService.isGwFinished(cur);
      const g = done ? cur : cur - 1;
      if (g >= 1) {
        const [pk, live] = await Promise.all([
          fplService.getGwPicks(user.fplTeamId, g),
          fplService.getLiveGwPoints(g),
        ]);
        const bench = (pk?.picks || []).filter((p: any) => p.multiplier === 0)
          .reduce((a: number, p: any) => a + (live[p.element] || 0), 0);
        const total = (pk?.entry_history?.points || 0) - (pk?.entry_history?.event_transfers_cost || 0);
        lastLine = bench >= 4
          ? `You left ${bench} points on your bench in Gameweek ${g}.`
          : `You scored ${total} in Gameweek ${g}.`;
      }
    }
  } catch (e) { /* optional */ }
  return {
    ready: true,
    gameweek: plan.gameweek,
    deadline: plan.deadline,
    match: plan.match
      ? {
          opponent: plan.match.opponent, me: plan.match.me, them: plan.match.them,
          winChance: plan.match.winChance, verdict: plan.match.verdict,
        }
      : null,
    captain: plan.captain?.pick?.name || null,
    lastLine,
  };
}
