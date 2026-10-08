import { Router } from "express";
import { authenticate, AuthRequest } from "../middleware/authenticate";
import { AppError } from "../utils/AppError";
import { fplService } from "../services/fpl";

export const fplRouter = Router();

/**
 * "Find my team" lookup.
 *
 * Most players cannot find their FPL Manager ID, because the FPL mobile app
 * never shows it — it only appears in a browser URL. So instead of asking for
 * the number, we read the standings of one Clashd league on FPL and let a
 * player pick themselves out of it by name.
 *
 * This league is used purely as a directory. It is never scored, never shown
 * as a competition, and has nothing to do with Clashd's own leagues.
 */

const PAGE_SIZE = 50;          // FPL returns 50 standings rows per page
const MAX_PAGES = 12;          // cap the crawl: 600 managers is well past our cap
const CACHE_TTL_MS = 5 * 60 * 1000;

type Member = { fplTeamId: number; teamName: string; managerName: string };

let cache: { at: number; members: Member[] } | null = null;

function leagueId(): number | null {
  const raw = process.env.CLASHD_FPL_LEAGUE_ID;
  if (!raw) return null;
  const id = parseInt(raw, 10);
  return isNaN(id) ? null : id;
}

async function loadMembers(force = false): Promise<Member[]> {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.members;

  const id = leagueId();
  if (!id) throw new AppError("Team lookup is not configured yet.", 503);

  const seen = new Set<number>();
  const members: Member[] = [];

  function add(entry: number, teamName: string, managerName: string) {
    if (!entry || seen.has(entry)) return;
    seen.add(entry);
    members.push({ fplTeamId: entry, teamName: teamName || "", managerName: managerName || "" });
  }

  // Managers who have joined but are not yet in the standings live under
  // new_entries. Before a gameweek has been scored — which includes the whole
  // pre-season — that is where EVERY member sits, so both must be read.
  // Standings and new entries are paged separately by FPL. Walking them on one
  // shared counter stopped at whichever ran out first, so in a league with more
  // than fifty members the newest joiners - exactly the people using this
  // screen - could be the ones left out.
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await fplService.getLeagueStandings(id, page, 1);
    for (const r of data?.standings?.results || []) {
      add(r.entry, r.entry_name, r.player_name);
    }
    if (!data?.standings?.has_next) break;
  }

  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await fplService.getLeagueStandings(id, 1, page);
    for (const r of data?.new_entries?.results || []) {
      const name = [r.player_first_name, r.player_last_name].filter(Boolean).join(" ");
      add(r.entry, r.entry_name, name);
    }
    if (!data?.new_entries?.has_next) break;
  }

  cache = { at: Date.now(), members };
  return members;
}

/**
 * GET /api/fpl/find?q=solvv
 * Returns managers in the Clashd league whose team or manager name matches.
 * A query is required so we never hand back the whole membership list.
 */
fplRouter.get("/find", authenticate, async (req: AuthRequest, res, next) => {
  try {
    const q = String(req.query.q || "").trim().toLowerCase();
    if (q.length < 2) {
      return next(new AppError("Type at least two characters to search.", 400));
    }

    const match = (list: Member[]) =>
      list
        .filter(
          (m) =>
            m.teamName.toLowerCase().includes(q) ||
            m.managerName.toLowerCase().includes(q)
        )
        .slice(0, 25);

    let matches = match(await loadMembers());

    // Somebody who joined the Clashd league a minute ago is not in the cache
    // yet, so the search that brought them here finds nothing and the screen
    // tells them to go and join - which they have just done. One forced
    // re-read on a miss costs a single FPL call and removes the dead end.
    let refreshed = false;
    if (!matches.length && cache && Date.now() - cache.at > 20_000) {
      matches = match(await loadMembers(true));
      refreshed = true;
    }

    res.json({ count: matches.length, results: matches, refreshed });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/fpl/league
 * Tells the app whether lookup is available, and the code players need to join
 * the Clashd league on FPL before they can be found.
 */
fplRouter.get("/league", authenticate, async (_req, res) => {
  const id = leagueId();
  res.json({
    available: !!id,
    leagueId: id,
    joinCode: process.env.CLASHD_FPL_LEAGUE_CODE || null,
  });
});
