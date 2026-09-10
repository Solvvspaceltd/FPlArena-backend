import { prisma } from "../utils/prisma";
import { fplService } from "../services/fpl";

/**
 * The "in-form 30" intelligence.
 *
 * Once per gameweek we identify the 30 managers with the best RECENT form (not
 * just high overall rank — someone can lead on an old score while going
 * backwards), read their squads and their transfers, and compute four things
 * every user's Analysis screen reads:
 *
 *   - consensus ownership (who the winners hold)
 *   - differential of the week (high among winners, low among everyone)
 *   - most transferred in (what the winners are buying)
 *   - most transferred out (what the winners are dumping)
 *
 * This is ONE shared computation served to all users, not per-user work. It is
 * the engineering heart of the Analysis feature, so it is built to be cheap and
 * cached: ~30 managers x (1 picks call + 1 transfers call) once a week.
 */

const FORM_POOL = 150;      // consider the top 150 overall, then rank by form
const IN_FORM_COUNT = 30;   // the pack we report on
const DELAY_MS = 250;

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

/** Recent form = points over the last N finished gameweeks, minus hits. */
function recentForm(history: any, sinceGw: number): number {
  const rows = (history?.current || []).filter(
    (g: any) => g.event > sinceGw
  );
  return rows.reduce(
    (sum: number, g: any) => sum + g.points - (g.event_transfers_cost || 0),
    0
  );
}

export async function computeFormPicks(gameweek: number) {
  // Only worth computing once a few gameweeks exist to measure form over.
  const lookback = Math.max(0, gameweek - 4);

  // 1. Pull a pool of high-ranked managers (3 pages = 150).
  const pool: { entry: number; overallRank: number }[] = [];
  for (let page = 1; page <= 3; page++) {
    const data = await fplService.getOverallTop(page);
    const rows = data?.standings?.results || [];
    for (const r of rows) pool.push({ entry: r.entry, overallRank: r.rank });
    await sleep(DELAY_MS);
    if (pool.length >= FORM_POOL) break;
  }
  if (!pool.length) return null;

  // 2. Rank the pool by recent form, take the top 30.
  const withForm: { entry: number; form: number }[] = [];
  for (const m of pool.slice(0, FORM_POOL)) {
    try {
      const hist = await fplService.getHistory(m.entry);
      withForm.push({ entry: m.entry, form: recentForm(hist, lookback) });
      await sleep(DELAY_MS);
    } catch (e) {
      /* skip a manager we can't read */
    }
  }
  withForm.sort((a, b) => b.form - a.form);
  const inForm = withForm.slice(0, IN_FORM_COUNT);
  if (!inForm.length) return null;

  // 3. Read their current squads and their transfers this gameweek.
  const ownCount = new Map<number, number>();   // element -> how many of the 30 own
  const inCount = new Map<number, number>();     // element -> transferred in
  const outCount = new Map<number, number>();    // element -> transferred out

  for (const m of inForm) {
    try {
      const picks = await fplService.getGwPicks(m.entry, gameweek);
      for (const p of picks?.picks || []) {
        ownCount.set(p.element, (ownCount.get(p.element) || 0) + 1);
      }
      await sleep(DELAY_MS);

      const transfers = await fplService.getTransfers(m.entry);
      for (const t of transfers.filter((x: any) => x.event === gameweek)) {
        inCount.set(t.element_in, (inCount.get(t.element_in) || 0) + 1);
        outCount.set(t.element_out, (outCount.get(t.element_out) || 0) + 1);
      }
      await sleep(DELAY_MS);
    } catch (e) {
      /* skip */
    }
  }

  // 4. Player metadata + overall ownership straight from bootstrap.
  const boot = await fplService.getBootstrap();
  const teamShort: Record<number, string> = {};
  for (const t of boot.teams || []) teamShort[t.id] = t.short_name;
  const POS: Record<number, string> = { 1: "GK", 2: "DEF", 3: "MID", 4: "FWD" };
  const elMap: Record<number, any> = {};
  for (const e of boot.elements || []) elMap[e.id] = e;

  const meta = (el: number) => {
    const e = elMap[el];
    return e
      ? {
          id: el,
          name: e.web_name,
          team: teamShort[e.team] || "",
          position: POS[e.element_type] || "",
          ownership: parseFloat(e.selected_by_percent || "0"),
        }
      : { id: el, name: "Unknown", team: "", position: "", ownership: 0 };
  };

  const owned = Array.from(ownCount.entries())
    .map(([el, count]) => ({ ...meta(el), count }))
    .sort((a, b) => b.count - a.count);

  // Differential of the week: highest among the 30, lowest overall ownership.
  const differentials = owned
    .filter((p) => p.count >= IN_FORM_COUNT * 0.4 && p.ownership < 15)
    .sort((a, b) => b.count / (b.ownership + 1) - a.count / (a.ownership + 1))
    .slice(0, 5);

  const mostIn = Array.from(inCount.entries())
    .map(([el, count]) => ({ ...meta(el), count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  const mostOut = Array.from(outCount.entries())
    .map(([el, count]) => ({ ...meta(el), count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  const snapshot = {
    gameweek,
    sampleSize: inForm.length,
    consensus: owned.slice(0, 15),
    differentials,
    mostIn,
    mostOut,
  };

  await prisma.formPickSnapshot.upsert({
    where: { gameweek },
    create: { gameweek, data: snapshot as any },
    update: { data: snapshot as any, computedAt: new Date() },
  });

  return snapshot;
}

/** Read the cached snapshot for a gameweek, computing it if missing. */
export async function getFormPicks(gameweek: number) {
  const cached = await prisma.formPickSnapshot.findUnique({ where: { gameweek } });
  if (cached) return cached.data;
  return computeFormPicks(gameweek);
}
