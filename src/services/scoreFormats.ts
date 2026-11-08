import { fplService } from "./fpl";

/**
 * Format-specific scoring.
 *
 * Until now every league was ranked the same way: cumulative FPL points minus
 * transfer hits. That is correct for a season league and wrong for everything
 * else, so Captain Royale was ranking people by overall points rather than
 * captain points. This module gives each format its own number.
 *
 * Everything here works from data we already fetch where possible, and caches
 * aggressively, because the FPL API is unofficial and throttled.
 */

/** What each part of a manager's side earned in one gameweek. */
export type PositionTotals = { gk: number; def: number; mid: number; fwd: number };

export type ScoreContext = {
  /** picks per manager per gameweek, keyed `${teamId}:${gw}` */
  picks: Map<string, any>;
  /**
   * Settled position subtotals, keyed `${teamId}:${gw}`.
   *
   * Once a gameweek is scored these four numbers never change, so they are
   * stored on the gw_scores row and read back here. A manager with subtotals
   * needs no squad in memory at all, which is what stops a pass growing by one
   * squad per manager per gameweek as the season runs on.
   */
  subtotals: Map<string, PositionTotals>;
  /** live player points per gameweek */
  live: Map<number, Record<number, number>>;
  /** transfers per manager */
  transfers: Map<number, Array<{ element_in: number; element_out: number; event: number }>>;
  /** throttle between network calls */
  sleep: (ms: number) => Promise<unknown>;
  delayMs: number;
};

export function newContext(sleep: (ms: number) => Promise<unknown>, delayMs = 250): ScoreContext {
  return {
    picks: new Map(),
    subtotals: new Map(),
    live: new Map(),
    transfers: new Map(),
    sleep,
    delayMs,
  };
}

/**
 * A manager's gameweek score, worked out from their squad and one shared list
 * of every player's points - no per-manager call to FPL at all.
 *
 * This is the whole basis of scoring Clashd at scale: FPL's live endpoint
 * returns every player in one request, and we already know who was in each
 * side, so the arithmetic is ours to do. Counts a player only if their
 * multiplier is above zero, which excludes an unused bench and includes an
 * automatic substitute, and applies the armband through that same multiplier.
 * Transfer hits come off the total, exactly as FPL reports them.
 */
export function pointsFromLive(picks: any, live: Record<number, number>): number {
  let total = 0;
  for (const pick of picks?.picks || []) {
    if (!pick.multiplier || pick.multiplier <= 0) continue;
    total += (live[pick.element] ?? 0) * pick.multiplier;
  }
  return total - (picks?.entry_history?.event_transfers_cost || 0);
}

/**
 * Put a manager's picks for a gameweek into the context without going to FPL.
 *
 * A finished gameweek cannot change: once the final match is played and the
 * bonus is applied, who was in the side and what their multiplier was are
 * settled forever. We already wrote that squad to gw_scores.teamSnapshot the
 * first time we scored it, so the sync loads it from our own database and
 * primes it here. Everything downstream then reads it out of this same cache
 * and never notices the difference.
 *
 * Only ever called with a gameweek FPL reports as data_checked - see the sync.
 */
/** Hand the scorer subtotals already worked out and stored. */
export function rememberPositionTotals(
  ctx: ScoreContext,
  teamId: number,
  gw: number,
  totals: PositionTotals
) {
  ctx.subtotals.set(`${teamId}:${gw}`, totals);
}

export function rememberPicks(
  ctx: ScoreContext,
  teamId: number,
  gw: number,
  picks: any[]
) {
  ctx.picks.set(`${teamId}:${gw}`, { picks });
}

async function getPicks(ctx: ScoreContext, teamId: number, gw: number) {
  const key = `${teamId}:${gw}`;
  if (ctx.picks.has(key)) return ctx.picks.get(key);
  const p = await fplService.getGwPicks(teamId, gw);
  ctx.picks.set(key, p);
  await ctx.sleep(ctx.delayMs);
  return p;
}

async function getLive(ctx: ScoreContext, gw: number) {
  if (ctx.live.has(gw)) return ctx.live.get(gw)!;
  const l = await fplService.getLiveGwPoints(gw);
  ctx.live.set(gw, l);
  await ctx.sleep(ctx.delayMs);
  return l;
}

async function getTransfers(ctx: ScoreContext, teamId: number) {
  if (ctx.transfers.has(teamId)) return ctx.transfers.get(teamId)!;
  const t = await fplService.getTransfers(teamId);
  ctx.transfers.set(teamId, t);
  await ctx.sleep(ctx.delayMs);
  return t;
}

/** Gameweeks in a league's range that have actually been played. */
function playedRange(history: any, startGw: number, endGw: number): number[] {
  return (history?.current || [])
    .map((g: any) => g.event)
    .filter((gw: number) => gw >= startGw && gw <= endGw)
    .sort((a: number, b: number) => a - b);
}

/**
 * Captain points for one gameweek: the captain's own score multiplied by the
 * armband (2, or 3 with a triple captain chip).
 */
/** element id -> element_type, fetched once per process. */
let POSITION_OF: Record<number, number> | null = null;

async function positionMap(): Promise<Record<number, number>> {
  if (POSITION_OF) return POSITION_OF;
  const players = await fplService.getPlayerMap();
  const out: Record<number, number> = {};
  for (const id of Object.keys(players)) {
    out[Number(id)] = players[Number(id)].position;
  }
  POSITION_OF = out;
  return out;
}

/**
 * What one part of a manager's side earned them in a gameweek.
 *
 * Counts every player of that position who actually scored for the manager -
 * which includes an automatic substitute who came on for somebody who did not
 * play, because those points are genuinely theirs.
 *
 * Deliberately raw: the captain's multiplier is NOT applied. Captaincy already
 * has its own competition, and if it counted here then Midfield Master would be
 * decided by whether a manager happened to captain a midfielder rather than by
 * how well they picked their midfield. These four are about building that part
 * of a squad, nothing else.
 */
export async function positionPointsForGw(
  ctx: ScoreContext,
  teamId: number,
  gw: number,
  elementType: number
): Promise<number> {
  const stored = ctx.subtotals.get(`${teamId}:${gw}`);
  if (stored) {
    if (elementType === 1) return stored.gk;
    if (elementType === 2) return stored.def;
    if (elementType === 3) return stored.mid;
    return stored.fwd;
  }

  const all = await positionBreakdownForGw(ctx, teamId, gw);
  if (elementType === 1) return all.gk;
  if (elementType === 2) return all.def;
  if (elementType === 3) return all.mid;
  return all.fwd;
}

/**
 * All four parts of a side in one pass over the squad.
 *
 * Working them out together rather than one position at a time is what makes
 * them worth storing: the sync computes this once when it scores a gameweek,
 * writes the four numbers to the gw_scores row, and no later pass ever has to
 * look at that squad again.
 */
export async function positionBreakdownForGw(
  ctx: ScoreContext,
  teamId: number,
  gw: number
): Promise<PositionTotals> {
  const empty: PositionTotals = { gk: 0, def: 0, mid: 0, fwd: 0 };

  const picks = await getPicks(ctx, teamId, gw);
  const list = picks?.picks || [];
  if (!list.length) return empty;

  const [live, pos] = await Promise.all([getLive(ctx, gw), positionMap()]);

  const out: PositionTotals = { gk: 0, def: 0, mid: 0, fwd: 0 };
  for (const p of list) {
    if (!p.multiplier || p.multiplier <= 0) continue; // did not count this week
    const points = live[p.element] ?? 0;
    const type = pos[p.element];
    if (type === 1) out.gk += points;
    else if (type === 2) out.def += points;
    else if (type === 3) out.mid += points;
    else if (type === 4) out.fwd += points;
  }
  return out;
}

export async function captainPointsForGw(
  ctx: ScoreContext,
  teamId: number,
  gw: number
): Promise<number> {
  const picks = await getPicks(ctx, teamId, gw);
  const list = picks?.picks || [];
  const captain = list.find((p: any) => p.is_captain) || list.find((p: any) => p.multiplier > 1);
  if (!captain) return 0;

  const live = await getLive(ctx, gw);
  const base = live[captain.element] ?? 0;
  const multiplier = captain.multiplier && captain.multiplier > 0 ? captain.multiplier : 2;
  return base * multiplier;
}

/**
 * The number an entry is ranked on, for its league's format.
 * Returns null when the format is the plain cumulative total, so the caller can
 * keep its existing behaviour.
 */
export async function scoreForFormat(
  format: string,
  ctx: ScoreContext,
  teamId: number,
  history: any,
  startGw: number,
  endGw: number
): Promise<number | null> {
  const gws = playedRange(history, startGw, endGw);
  if (!gws.length) return 0;

  const rows: any[] = (history?.current || []).filter(
    (g: any) => g.event >= startGw && g.event <= endGw
  );

  switch (format) {
    /**
     * A weekly league is not cumulative. It ranks on the most recent played
     * gameweek only, so the table resets every week and a bad start never rules
     * anyone out. One league can then run all season instead of needing a new
     * one created every gameweek.
     */
    case "WEEKLY_HIGH": {
      const latest = rows
        .filter((g) => typeof g.event === "number")
        .sort((a, b) => b.event - a.event)[0];
      if (!latest) return 0;
      return latest.points - (latest.event_transfers_cost || 0);
    }

    /**
     * The four positional competitions. Same shape, different part of the
     * pitch: add up what your keeper, defenders, midfielders or forwards
     * earned you, every gameweek, all season.
     *
     * Golden Glove is one player where the others are three to five, so its
     * numbers are far smaller and its table far tighter. That is the point of
     * it - picking a keeper is a real skill that a combined points total
     * completely hides.
     */
    case "GOLDEN_GLOVE":
    case "PARKED_BUS":
    case "MIDFIELD_MASTER":
    case "ELECTRIC_ATTACKER": {
      const TYPE: Record<string, number> = {
        GOLDEN_GLOVE: 1, PARKED_BUS: 2, MIDFIELD_MASTER: 3, ELECTRIC_ATTACKER: 4,
      };
      const elementType = TYPE[format];
      let total = 0;
      for (const gw of gws) {
        total += await positionPointsForGw(ctx, teamId, gw, elementType);
      }
      return total;
    }

    /** Most points scored by captains across the range. */
    case "CAPTAIN_POINTS": {
      let total = 0;
      for (const gw of gws) {
        total += await captainPointsForGw(ctx, teamId, gw);
      }
      return total;
    }

    /**
     * Finish the range without a single points hit. Anyone who has taken one is
     * out, and is ranked below every qualifier. Qualifiers are then separated by
     * their points, so the league still has a winner rather than a tie.
     */
    case "NO_HITS": {
      const hits = rows.reduce((sum, g) => sum + (g.event_transfers_cost || 0), 0);
      const points = rows.reduce((sum, g) => sum + g.points, 0);
      if (hits > 0) return -hits; // negative sorts below every clean manager
      return points;
    }

    /**
     * Green arrows: the NUMBER of gameweeks where overall rank improved, not the
     * size of the improvement. This is what the league is named after and what
     * its rules say, and it rewards consistency rather than one enormous week.
     * Ties are broken by total places gained.
     */
    case "RANK_CLIMB": {
      const ranked = rows.filter((g) => typeof g.overall_rank === "number");
      if (ranked.length < 2) return 0;

      let arrows = 0;
      let placesGained = 0;
      for (let i = 1; i < ranked.length; i++) {
        const before = ranked[i - 1].overall_rank;
        const after = ranked[i].overall_rank;
        if (after < before) {
          arrows++;
          placesGained += before - after;
        }
      }

      // totalPoints is an integer column, so the tiebreak is encoded rather
      // than fractional: arrows occupy the millions, places gained the rest.
      // 38 arrows is 38,000,000, comfortably inside a 32 bit integer.
      return arrows * 1000000 + Math.min(999999, Math.max(0, placesGained));
    }

    /**
     * Net points your transfers earned, minus what they cost.
     *
     * For every transfer, compare what the player coming in scored against what
     * the player going out scored, in the gameweek the transfer took effect.
     * That is a well defined and explainable measure: did this week's transfers
     * pay for themselves?
     */
    case "TRANSFER_NET": {
      const transfers = await getTransfers(ctx, teamId);
      const inRange = transfers.filter((t) => t.event >= startGw && t.event <= endGw);

      let gained = 0;
      const byGw = new Map<number, typeof inRange>();
      for (const t of inRange) {
        if (!byGw.has(t.event)) byGw.set(t.event, []);
        byGw.get(t.event)!.push(t);
      }

      for (const [gw, list] of byGw) {
        if (!gws.includes(gw)) continue;
        const live = await getLive(ctx, gw);
        for (const t of list) {
          gained += (live[t.element_in] ?? 0) - (live[t.element_out] ?? 0);
        }
      }

      const cost = rows.reduce((sum, g) => sum + (g.event_transfers_cost || 0), 0);
      return gained - cost;
    }

    default:
      return null; // caller keeps the cumulative total
  }
}

/** Formats that need per-gameweek work beyond the cumulative total. */
export function isSpecialFormat(format: string) {
  return ["CAPTAIN_POINTS", "NO_HITS", "RANK_CLIMB", "TRANSFER_NET"].includes(format);
}

/** How a format's score should be described in the app. */
export function scoreLabel(format: string) {
  switch (format) {
    case "CAPTAIN_POINTS": return "Captain pts";
    case "NO_HITS": return "Clean pts";
    case "RANK_CLIMB": return "Green arrows";
    case "TRANSFER_NET": return "Net transfer pts";
    case "SEVEN_ASIDE":
    case "FIVE_ASIDE": return "Aside pts";
    case "WEEKLY_HIGH": return "GW pts";
    default: return "Points";
  }
}


/**
 * RANK_CLIMB stores its tiebreak inside the integer: arrows in the millions,
 * places gained below. That encoding is ours, not the manager's, so it is
 * decoded here before any of it reaches a client. Everything else passes
 * through untouched.
 */
export function displayScore(format: string, total: number) {
  if (format === "RANK_CLIMB") {
    return {
      value: Math.floor(total / 1000000),
      detail: total % 1000000,
      label: "Green arrows",
    };
  }
  return { value: total, detail: null as number | null, label: scoreLabel(format) };
}
