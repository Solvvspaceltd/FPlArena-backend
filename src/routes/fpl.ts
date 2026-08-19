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

async function loadMembers(): Promise<Member[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.members;

  const id = leagueId();
  if (!id) throw new AppError("Team lookup is not configured yet.", 503);

  const members: Member[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await fplService.getLeagueStandings(id, page);
    const rows = data?.standings?.results || [];
    for (const r of rows) {
      if (!r.entry) continue;
      members.push({
        fplTeamId: r.entry,
        teamName: r.entry_name || "",
        managerName: r.player_name || "",
      });
    }
    if (!data?.standings?.has_next || rows.length < PAGE_SIZE) break;
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

    const members = await loadMembers();
    const matches = members
      .filter(
        (m) =>
          m.teamName.toLowerCase().includes(q) ||
          m.managerName.toLowerCase().includes(q)
      )
      .slice(0, 25);

    res.json({ count: matches.length, results: matches });
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
