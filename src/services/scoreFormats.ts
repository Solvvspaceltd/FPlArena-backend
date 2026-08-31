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

export type ScoreContext = {
  /** picks per manager per gameweek, keyed `${teamId}:${gw}` */
  picks: Map<string, any>;
  /** live player points per gameweek */
  live: Map<number, Record<number, number>>;
  /** transfers per manager */
  transfers: Map<number, Array<{ element_in: number; element_out: number; event: number }>>;
  /** throttle between network calls */
  sleep: (ms: number) => Promise<unknown>;
  delayMs: number;
};

export function newContext(sleep: (ms: number) => Promise<unknown>, delayMs = 250): ScoreContext {
  return { picks: new Map(), live: new Map(), transfers: new Map(), sleep, delayMs };
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
