import axios from "axios";
import { fplService } from "./fpl";
import { prisma } from "../utils/prisma";

/**
 * Clashd forecasting engine.
 *
 * Expected points for every player over the next few gameweeks, built only
 * from FPL's public data: each player's season expected goals, expected
 * assists, minutes, defensive contributions, availability flags and bonus,
 * set against the strength of each opponent. Two FPL calls (bootstrap and
 * fixtures), both already cached, so a full recompute is cheap and every
 * user reads the same numbers.
 *
 * The model per fixture:
 *   appearance  + goals + assists + clean sheet + defensive contribution
 *   + saves + bonus - goals conceded - cards
 * each scaled by the chance the player plays, with early-season numbers
 * shrunk towards a price-aware prior so two good games do not make a star.
 */

const fplApi = axios.create({
  baseURL: process.env.FPL_API_BASE || "https://fantasy.premierleague.com/api",
  timeout: 15000,
  headers: { "User-Agent": "FPLArena/2.0" },
});

export const HORIZON = 6;

// FPL scoring by element_type (1 GK, 2 DEF, 3 MID, 4 FWD).
const GOAL_PTS: Record<number, number> = { 1: 10, 2: 6, 3: 5, 4: 4 };
const CS_PTS: Record<number, number> = { 1: 4, 2: 4, 3: 1, 4: 0 };
const DEFCON_THRESHOLD: Record<number, number> = { 1: 99, 2: 10, 3: 12, 4: 12 };

// Priors per 90 minutes, before price scaling. Shrinkage strength K is in
// 90-minute equivalents: with K = 3 a player needs about three full games
// before his own numbers outweigh the prior.
const PRIOR_XG: Record<number, number> = { 1: 0, 2: 0.05, 3: 0.14, 4: 0.34 };
const PRIOR_XA: Record<number, number> = { 1: 0.01, 2: 0.06, 3: 0.14, 4: 0.11 };
const PRIOR_DC: Record<number, number> = { 1: 0, 2: 8.5, 3: 7, 4: 3 };
const K = 3;

export type PlayerForecast = {
  id: number;
  name: string;
  team: number;
  teamShort: string;
  pos: number;
  price: number; // £m
  owned: number; // selected_by_percent
  status: string;
  news: string;
  xp: number[]; // one per gameweek in the horizon, index 0 = next gameweek
  total: number; // sum across the horizon
  next: number; // xp[0]
  haul: number; // chance of 10+ points next gameweek (base, before captaincy)
  variance: number; // for match win-chance maths
  fixtures: { gw: number; opp: string; home: boolean; difficulty: number }[][];
  ep: number; // FPL's own ep_next, kept for the published record
};

export type Projections = {
  fromGw: number;
  horizon: number;
  players: Record<number, PlayerForecast>;
  computedAt: number;
  scale?: number;
};

function num(v: any, d = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function poissonPmf(lam: number, k: number) {
  let p = Math.exp(-lam);
  for (let i = 1; i <= k; i++) p *= lam / i;
  return p;
}

function poissonAtLeast(lam: number, t: number) {
  if (lam <= 0) return 0;
  let below = 0;
  for (let k = 0; k < t; k++) below += poissonPmf(lam, k);
  return clamp(1 - below, 0, 1);
}

// Expected value of floor(X / 2) for X ~ Poisson(lam): goals conceded points.
function expectedHalfFloor(lam: number) {
  let e = 0;
  for (let k = 2; k <= 12; k++) e += poissonPmf(lam, k) * Math.floor(k / 2);
  return e;
}

let cache: Projections | null = null;
const TTL_MS = 10 * 60 * 1000;

/** Forecasts for every player from the next gameweek, cached for ten minutes. */
export async function getProjections(force = false): Promise<Projections> {
  if (!force && cache && Date.now() - cache.computedAt < TTL_MS) return cache;
  const next = await fplService.getNextGameweek();
  const boot = await fplService.getBootstrap();
  const fromGw = next?.id ?? ((await fplService.getCurrentGameweek()) || 1) + 1;
  const fixtures = await fplService.getUpcomingFixtures(fromGw, HORIZON);
  cache = computeProjections(boot, fixtures, fromGw, HORIZON);
  return cache;
}

export function computeProjections(boot: any, fixtures: any[], fromGw: number, horizon: number): Projections {
  const teams: any[] = boot.teams || [];
  const elements: any[] = boot.elements || [];
  const short: Record<number, string> = {};
  for (const t of teams) short[t.id] = t.short_name;

  // ---- Team games played, from finished fixtures ----
  const played: Record<number, number> = {};
  for (const t of teams) played[t.id] = 0;
  for (const f of fixtures || []) {
    if (f.finished || f.finished_provisional) {
      played[f.team_h] = (played[f.team_h] || 0) + 1;
      played[f.team_a] = (played[f.team_a] || 0) + 1;
    }
  }

  // ---- Team attack and defence from player expected goals ----
  const teamXg: Record<number, number> = {};
  const teamXgc: Record<number, number> = {};
  const gkMins: Record<number, number> = {};
  for (const t of teams) { teamXg[t.id] = 0; teamXgc[t.id] = 0; gkMins[t.id] = 0; }
  for (const e of elements) {
    teamXg[e.team] = (teamXg[e.team] || 0) + num(e.expected_goals);
    // A team's expected goals conceded is what its goalkeepers were on the
    // pitch for; weight by minutes so a rotated keeper is not double counted.
    if (e.element_type === 1) {
      teamXgc[e.team] = (teamXgc[e.team] || 0) + num(e.expected_goals_conceded);
      gkMins[e.team] = (gkMins[e.team] || 0) + num(e.minutes);
    }
  }

  const PRIOR_GAMES = 3;
  let sumXgPg = 0; let n = 0;
  for (const t of teams) {
    const gp = played[t.id] || 0;
    sumXgPg += gp ? teamXg[t.id] / gp : 0;
    n += gp ? 1 : 0;
  }
  const leagueXgPg = n ? sumXgPg / n : 1.35;

  const attPg: Record<number, number> = {};
  const defPg: Record<number, number> = {};
  for (const t of teams) {
    const gp = played[t.id] || 0;
    const gkGames = gkMins[t.id] / 90;
    attPg[t.id] = (teamXg[t.id] + leagueXgPg * PRIOR_GAMES) / (gp + PRIOR_GAMES);
    defPg[t.id] = (teamXgc[t.id] + leagueXgPg * PRIOR_GAMES) / (gkGames + PRIOR_GAMES);
  }

  // FPL's own strength ratings, blended in so early-season noise is damped.
  const avg = (key: string) => {
    const vals = teams.map((t) => num(t[key])).filter((v) => v > 0);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 1;
  };
  const avgAttH = avg("strength_attack_home"); const avgAttA = avg("strength_attack_away");
  const avgDefH = avg("strength_defence_home"); const avgDefA = avg("strength_defence_away");
  const byId: Record<number, any> = {};
  for (const t of teams) byId[t.id] = t;

  // How much easier than average it is to score against `opp`.
  function attackFactor(opp: number, oppHome: boolean) {
    const data = defPg[opp] / leagueXgPg;
    const s = num(byId[opp]?.[oppHome ? "strength_defence_home" : "strength_defence_away"]);
    const fpl = s > 0 ? Math.pow((oppHome ? avgDefH : avgDefA) / s, 2) : 1;
    return clamp(0.5 * data + 0.5 * fpl, 0.45, 1.9);
  }
  // How dangerous `opp` is going forward.
  function threatFactor(opp: number, oppHome: boolean) {
    const data = attPg[opp] / leagueXgPg;
    const s = num(byId[opp]?.[oppHome ? "strength_attack_home" : "strength_attack_away"]);
    const fpl = s > 0 ? Math.pow(s / (oppHome ? avgAttH : avgAttA), 2) : 1;
    return clamp(0.5 * data + 0.5 * fpl, 0.45, 1.9);
  }

  // ---- Fixtures per team per gameweek in the horizon ----
  const teamFx: Record<number, { gw: number; opp: number; home: boolean; difficulty: number }[][]> = {};
  for (const t of teams) teamFx[t.id] = Array.from({ length: horizon }, () => []);
  for (const f of fixtures || []) {
    if (!f.event) continue;
    const i = f.event - fromGw;
    if (i < 0 || i >= horizon) continue;
    teamFx[f.team_h]?.[i]?.push({ gw: f.event, opp: f.team_a, home: true, difficulty: num(f.team_h_difficulty, 3) });
    teamFx[f.team_a]?.[i]?.push({ gw: f.event, opp: f.team_h, home: false, difficulty: num(f.team_a_difficulty, 3) });
  }

  // Average price per position, for price-aware priors.
  const priceSum: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  const priceN: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const e of elements) {
    if (priceSum[e.element_type] === undefined) continue;
    priceSum[e.element_type] += num(e.now_cost);
    priceN[e.element_type] += 1;
  }

  const players: Record<number, PlayerForecast> = {};
  for (const e of elements) {
    const pos: number = e.element_type;
    if (!GOAL_PTS[pos]) continue; // managers and anything else
    const gp = Math.max(1, played[e.team] || 0);
    const mins = num(e.minutes);
    const starts = num(e.starts, mins >= 60 ? Math.round(mins / 85) : 0);
    const nineties = mins / 90;
    const priceRatio = priceN[pos] ? clamp(num(e.now_cost) / (priceSum[pos] / priceN[pos]), 0.6, 2.2) : 1;

    // ---- Minutes ----
    const hasPlayed = (played[e.team] || 0) > 0;
    let pStart = hasPlayed ? clamp(starts / gp, 0, 1) : clamp(num(e.ep_next) / 5, 0, 0.9);
    const xMinWhenPlaying = starts > 0 ? clamp(mins / Math.max(starts, 1), 30, 90) : 25;
    const pSub = mins > 0 ? clamp((1 - pStart) * 0.35, 0, 0.4) : 0;
    const p60 = pStart * (xMinWhenPlaying >= 75 ? 0.9 : 0.7);
    const xMin = pStart * xMinWhenPlaying + pSub * 20; // expected minutes per match

    // ---- Per-90 rates, shrunk towards a price-aware prior ----
    const xg90 = (num(e.expected_goals) + PRIOR_XG[pos] * priceRatio * K) / (nineties + K);
    const xa90 = (num(e.expected_assists) + PRIOR_XA[pos] * priceRatio * K) / (nineties + K);
    const dcTotal = e.defensive_contribution != null ? num(e.defensive_contribution) : null;
    const dc90 = dcTotal == null ? 0 : (dcTotal + PRIOR_DC[pos] * K) / (nineties + K);
    const saves90 = pos === 1 ? (num(e.saves) + 2.6 * K) / (nineties + K) : 0;
    const bonusPg = (num(e.bonus) + 0.25 * priceRatio * 2) / (gp + 2);
    const yellowPg = (num(e.yellow_cards) + 0.12 * 2) / (gp + 2);

    // ---- Availability ----
    const status: string = e.status || "a";
    const chance = e.chance_of_playing_next_round;
    let avail0 = status === "a" ? 1 : chance != null ? num(chance) / 100 : status === "d" ? 0.5 : 0;
    if (status === "u" || status === "n") avail0 = 0;

    const xp: number[] = [];
    const fxOut: PlayerForecast["fixtures"] = [];
    let variance = 0;
    let haul = 0;
    for (let i = 0; i < horizon; i++) {
      // Injured and suspended players drift back towards their usual minutes.
      const avail = status === "u" || status === "n"
        ? 0
        : i === 0 ? avail0 : clamp(avail0 + (1 - avail0) * Math.min(1, i * 0.34), 0, 1);
      let sum = 0;
      const list = teamFx[e.team]?.[i] || [];
      fxOut.push(list.map((f) => ({ gw: f.gw, opp: short[f.opp] || "", home: f.home, difficulty: f.difficulty })));
      for (const f of list) {
        const ha = f.home ? 1.08 : 0.93;
        const att = attackFactor(f.opp, !f.home) * ha;
        const thr = threatFactor(f.opp, !f.home) * (f.home ? 0.93 : 1.08);

        const lamG = xg90 * (xMin / 90) * att;
        const lamA = xa90 * (xMin / 90) * att;
        const lamConceded = defPg[e.team] * thr;
        const pCs = Math.exp(-lamConceded);

        let pts = 0;
        pts += p60 * 2 + (pStart - p60 + pSub) * 1; // appearance
        pts += lamG * GOAL_PTS[pos];
        pts += lamA * 3;
        pts += p60 * pCs * CS_PTS[pos];
        if (pos <= 2) pts -= p60 * expectedHalfFloor(lamConceded);
        if (pos === 1) pts += pStart * (saves90 * thr) / 3;
        if (dc90 > 0 && pos >= 2) {
          const mean = dc90 * (xMinWhenPlaying / 90);
          pts += pStart * poissonAtLeast(mean, DEFCON_THRESHOLD[pos]) * 2;
        }
        pts += bonusPg * (pos >= 3 ? 0.7 + 0.3 * att : 0.8 + 0.4 * pCs) * (pStart > 0 ? 1 : 0);
        pts -= yellowPg;
        pts *= avail;
        sum += pts;

        if (i === 0) {
          variance += 1.9 * Math.max(0, pts) + 0.6 * avail;
          const lamN = (lamG + lamA) * avail;
          let h = 0;
          if (pos >= 3) h = poissonAtLeast(lamN, 2);
          else if (pos === 2) h = poissonAtLeast(lamG * avail, 1) * pCs + poissonAtLeast(lamN, 2) * (1 - pCs) * 0.5;
          else h = 0.05 * pCs * avail;
          haul = 1 - (1 - haul) * (1 - clamp(h * (p60 / Math.max(pStart, 0.01)), 0, 1));
        }
      }
      xp.push(Math.round(Math.max(0, sum) * 100) / 100);
    }

    const total = Math.round(xp.reduce((a, b) => a + b, 0) * 10) / 10;
    players[e.id] = {
      id: e.id,
      name: e.web_name,
      team: e.team,
      teamShort: short[e.team] || "",
      pos,
      price: num(e.now_cost) / 10,
      owned: num(e.selected_by_percent),
      status,
      news: e.news || "",
      xp,
      total,
      next: xp[0] || 0,
      haul: Math.round(haul * 100) / 100,
      variance,
      fixtures: fxOut,
      ep: num(e.ep_next),
    };
  }

  // ---- Calibrate the overall level against FPL's own forecast ----
  // Our ordering is our own; the scale is anchored so the average regular
  // starter lands where FPL's expected points put him. This stops the whole
  // table drifting high or low while the season's samples are still small.
  let ours = 0; let theirs = 0;
  for (const p of Object.values(players)) {
    if (p.ep >= 2 && p.next > 0) { ours += p.next; theirs += p.ep; }
  }
  const scale = ours > 0 && theirs > 0 ? clamp(theirs / ours, 0.75, 1.25) : 1;
  if (scale !== 1) {
    for (const p of Object.values(players)) {
      p.xp = p.xp.map((v) => Math.round(v * scale * 100) / 100);
      p.total = Math.round(p.xp.reduce((a, b) => a + b, 0) * 10) / 10;
      p.next = p.xp[0] || 0;
      p.variance *= scale;
    }
  }

  return { fromGw, horizon, players, computedAt: Date.now(), scale };
}

// ---------------------------------------------------------------------------
// Squad helpers
// ---------------------------------------------------------------------------

/** The best eleven from a set of player ids for one gameweek (index i). */
export function bestXI(ids: number[], proj: Projections, i: number) {
  const pl = ids.map((id) => proj.players[id]).filter(Boolean);
  const byPos = (p: number) => pl.filter((x) => x.pos === p).sort((a, b) => b.xp[i] - a.xp[i]);
  const gk = byPos(1).slice(0, 1);
  const def = byPos(2); const mid = byPos(3); const fwd = byPos(4);
  const chosen = [...gk, ...def.slice(0, 3), ...mid.slice(0, 2), ...fwd.slice(0, 1)];
  const max: Record<number, number> = { 2: 5, 3: 5, 4: 3 };
  const count: Record<number, number> = { 2: Math.min(3, def.length), 3: Math.min(2, mid.length), 4: Math.min(1, fwd.length) };
  const rest = [...def.slice(3), ...mid.slice(2), ...fwd.slice(1)].sort((a, b) => b.xp[i] - a.xp[i]);
  for (const p of rest) {
    if (chosen.length >= 11) break;
    if (count[p.pos] < max[p.pos]) { chosen.push(p); count[p.pos] += 1; }
  }
  return chosen;
}

/** Normal CDF, for turning a forecast margin into a win chance. */
export function phi(x: number) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

// ---------------------------------------------------------------------------
// The published record: forecasts are saved before each deadline and scored
// against what happened once the gameweek is checked.
// Stored in form_pick_snapshots under gameweek 1000 + N so no migration is
// needed; the in-form snapshots only ever use real gameweek numbers.
// ---------------------------------------------------------------------------

const RECORD_OFFSET = 1000;

export async function saveForecastSnapshot(proj: Projections) {
  try {
    const key = RECORD_OFFSET + proj.fromGw;
    const existing = await prisma.formPickSnapshot.findUnique({ where: { gameweek: key } });
    if (existing && Date.now() - new Date(existing.computedAt).getTime() < 30 * 60 * 1000) return;
    const xp: Record<number, number> = {};
    const ep: Record<number, number> = {};
    let top: { id: number; name: string; xp: number } | null = null;
    for (const p of Object.values(proj.players)) {
      if (p.next <= 0) continue;
      xp[p.id] = Math.round(p.next * 100) / 100;
      ep[p.id] = p.ep;
      if (!top || p.next > top.xp) top = { id: p.id, name: p.name, xp: p.next };
    }
    const data = { kind: "forecast", gameweek: proj.fromGw, xp, ep, top };
    await prisma.formPickSnapshot.upsert({
      where: { gameweek: key },
      create: { gameweek: key, data: data as any },
      update: { data: data as any, computedAt: new Date() },
    });
  } catch (e) {
    console.error("[projections] snapshot save failed", e);
  }
}

/** Score the saved forecast for a finished gameweek. Cached once computed. */
export async function getRecord(gw: number) {
  try {
    const key = RECORD_OFFSET + gw;
    const row = await prisma.formPickSnapshot.findUnique({ where: { gameweek: key } });
    if (!row) return null;
    const data: any = row.data;
    if (data.record) return data.record;
    const finished = await fplService.isGwFinished(gw);
    if (!finished) return null;

    const { data: live } = await fplApi.get(`/event/${gw}/live/`);
    if (typeof live === "string") return null;
    const actual: Record<number, { pts: number; mins: number }> = {};
    for (const el of live.elements || []) {
      actual[el.id] = { pts: num(el.stats?.total_points), mins: num(el.stats?.minutes) };
    }

    let n = 0; let beat = 0; let maeOurs = 0; let maeFpl = 0;
    for (const id of Object.keys(data.xp || {})) {
      const a = actual[Number(id)];
      if (!a || a.mins <= 0) continue;
      const ours = Math.abs(num(data.xp[id]) - a.pts);
      const fpl = Math.abs(num(data.ep?.[id]) - a.pts);
      n += 1; maeOurs += ours; maeFpl += fpl;
      if (ours < fpl) beat += 1;
    }
    if (!n) return null;
    const record = {
      gameweek: gw,
      players: n,
      beatFplPct: Math.round((beat / n) * 100),
      errorOurs: Math.round((maeOurs / n) * 100) / 100,
      errorFpl: Math.round((maeFpl / n) * 100) / 100,
      topPick: data.top ? { name: data.top.name, points: actual[data.top.id]?.pts ?? 0 } : null,
    };
    await prisma.formPickSnapshot.update({
      where: { gameweek: key },
      data: { data: { ...data, record } as any },
    });
    return record;
  } catch (e) {
    console.error("[projections] record failed", e);
    return null;
  }
}
