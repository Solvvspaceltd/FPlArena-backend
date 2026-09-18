import axios from "axios";

const api = axios.create({
  baseURL: process.env.FPL_API_BASE || "https://fantasy.premierleague.com/api",
  timeout: 15000,
  headers: { "User-Agent": "FPLArena/2.0" },
});

// bootstrap-static is a large payload (~1MB) and several helpers need it.
// Cache it briefly so a burst of squad loads does not refetch it each time.
let bootstrapCache: { data: any; at: number } | null = null;
let fixturesCache: { data: any; at: number } | null = null;
const FIXTURES_TTL_MS = 1000 * 60 * 60 * 6;
const BOOTSTRAP_TTL_MS = 5 * 60 * 1000;

export const fplService = {
  async getTeam(teamId: number) {
    try {
      const { data } = await api.get(`/entry/${teamId}/`);
    this.assertUsable(data, "team");
      return data;
    } catch (e: any) {
      if (e.response?.status === 404) return null;
      throw e;
    }
  },

  async getGwPicks(teamId: number, gw: number) {
    try {
      const { data } = await api.get(`/entry/${teamId}/event/${gw}/picks/`);
    this.assertUsable(data, "picks");
      return data;
    } catch (e: any) {
      if (e.response?.status === 404) return null;
      throw e;
    }
  },

  async getHistory(teamId: number) {
    const { data } = await api.get(`/entry/${teamId}/history/`);
    this.assertUsable(data, "history");
    return data;
  },

  async getBootstrap(force = false) {
    if (!force && bootstrapCache && Date.now() - bootstrapCache.at < BOOTSTRAP_TTL_MS) {
      return bootstrapCache.data;
    }
    const { data } = await api.get("/bootstrap-static/");
    this.assertUsable(data, "bootstrap");
    bootstrapCache = { data, at: Date.now() };
    return data;
  },

  async getCurrentGameweek(): Promise<number | null> {
    const b = await this.getBootstrap();
    return b.events.find((e: any) => e.is_current)?.id ?? null;
  },

  // Per-player points for a gameweek. Used to score Aside selections.
  // Returns a map of playerId -> total points for that GW.
  async getLiveGwPoints(gw: number): Promise<Record<number, number>> {
    const { data } = await api.get(`/event/${gw}/live/`);
    const out: Record<number, number> = {};
    for (const el of data.elements || []) {
      out[el.id] = el.stats?.total_points ?? 0;
    }
    return out;
  },

  // Player metadata (name, position, team) keyed by player id.
  // element_type: 1=GK 2=DEF 3=MID 4=FWD
  async getPlayerMap(): Promise<Record<number, any>> {
    const b = await this.getBootstrap();
    const teams: Record<number, string> = {};
    for (const t of b.teams || []) teams[t.id] = t.short_name;
    const out: Record<number, any> = {};
    for (const e of b.elements || []) {
      out[e.id] = {
        id: e.id,
        name: e.web_name,
        position: e.element_type,
        team: teams[e.team] || "",
        price: e.now_cost / 10,
      };
    }
    return out;
  },

  // The next gameweek that has not yet passed its deadline, with its deadline.
  async getNextGameweek(): Promise<{ id: number; deadline: string } | null> {
    const b = await this.getBootstrap();
    const ev = b.events.find((e: any) => e.is_next) || b.events.find((e: any) => !e.finished);
    return ev ? { id: ev.id, deadline: ev.deadline_time } : null;
  },

  // Has this gameweek's deadline passed? Picks only become public after it has.
  async isDeadlinePassed(gw: number): Promise<boolean> {
    const b = await this.getBootstrap();
    const ev = b.events.find((e: any) => e.id === gw);
    if (!ev) return false;
    return new Date(ev.deadline_time).getTime() <= Date.now();
  },

  /**
   * One page of a classic league's standings.
   * results[] entries carry: entry (the Manager ID), entry_name (team name),
   * player_name (the manager's real name).
   */
  async getLeagueStandings(leagueId: number, page = 1, newEntriesPage = 1) {
    const { data } = await api.get(
      `/leagues-classic/${leagueId}/standings/?page_standings=${page}` +
      `&page_new_entries=${newEntriesPage}`
    );
    this.assertUsable(data, "standings");
    return data;
  },

  /**
   * Player availability news straight from the official FPL data: injuries,
   * suspensions, doubts and returns. Each element carries a `news` string and
   * a `news_added` timestamp, so this needs no scraping or third-party feed.
   */
  async getPlayerNews(limit = 40) {
    const b = await this.getBootstrap();
    const teams: Record<number, string> = {};
    for (const t of b.teams || []) teams[t.id] = t.short_name;

    const items = (b.elements || [])
      .filter((e: any) => e.news && e.news.trim().length > 0 && e.news_added)
      .map((e: any) => ({
        id: "fpl-" + e.id + "-" + e.news_added,
        player: e.web_name,
        team: teams[e.team] || "",
        news: e.news.trim(),
        chance: e.chance_of_playing_next_round,
        at: e.news_added,
      }))
      .sort((a: any, b2: any) => new Date(b2.at).getTime() - new Date(a.at).getTime());

    return items.slice(0, limit);
  },

  /** Every transfer a manager has made this season. */
  /** Top managers from the global overall league (id 314), one page = 50. */
  async getOverallTop(page = 1) {
    const { data } = await api.get(
      `/leagues-classic/314/standings/?page_standings=${page}`
    );
    this.assertUsable(data, "overall");
    return data;
  },

  /**
   * FPL blocks its API during live scoring by returning HTTP 200 with the plain
   * string "The game is being updated." — not an error status. Without this
   * guard, callers read properties off a string, get undefined, and silently
   * write nothing (which is why team names were going stale).
   */
  assertUsable(data: any, what: string) {
    if (typeof data === "string") {
      throw new Error(`FPL unavailable (${what}): ${data.slice(0, 60)}`);
    }
    return data;
  },

  /**
   * Upcoming fixtures with FPL's own difficulty rating (1 easy to 5 hard).
   * Cached, because it changes rarely and every analysis request wants it.
   */
  async getUpcomingFixtures(fromGw: number, count = 5) {
    const now = Date.now();
    if (fixturesCache && now - fixturesCache.at < FIXTURES_TTL_MS) {
      return fixturesCache.data;
    }
    const { data } = await api.get("/fixtures/");
    this.assertUsable(data, "fixtures");
    fixturesCache = { data, at: now };
    return data;
  },

  /**
   * Average FPL difficulty facing each team over the next `count` gameweeks,
   * as a map of teamId -> { avg, fixtures: [{ gw, opponent, home, difficulty }] }.
   */
  async teamDifficulty(fromGw: number, count = 5) {
    const all = await this.getUpcomingFixtures(fromGw, count);
    const boot = await this.getBootstrap();
    const shortName: Record<number, string> = {};
    for (const t of boot.teams || []) shortName[t.id] = t.short_name;

    const out: Record<number, any> = {};
    for (const t of boot.teams || []) out[t.id] = { fixtures: [], avg: 0 };

    for (const f of all) {
      if (!f.event || f.event < fromGw || f.event >= fromGw + count) continue;
      if (out[f.team_h]) {
        out[f.team_h].fixtures.push({
          gw: f.event, opponent: shortName[f.team_a] || "", home: true,
          difficulty: f.team_h_difficulty,
        });
      }
      if (out[f.team_a]) {
        out[f.team_a].fixtures.push({
          gw: f.event, opponent: shortName[f.team_h] || "", home: false,
          difficulty: f.team_a_difficulty,
        });
      }
    }

    for (const id of Object.keys(out)) {
      const list = out[Number(id)].fixtures;
      out[Number(id)].avg = list.length
        ? Math.round((list.reduce((a: number, b: any) => a + b.difficulty, 0) / list.length) * 10) / 10
        : 0;
      out[Number(id)].short = shortName[Number(id)] || "";
    }
    return out;
  },

  async getTransfers(teamId: number) {
    const { data } = await api.get(`/entry/${teamId}/transfers/`);
    this.assertUsable(data, "transfers");
    return data as Array<{ element_in: number; element_out: number; event: number }>;
  },

  async isGwFinished(gw: number): Promise<boolean> {
    const b = await this.getBootstrap();
    return b.events.find((e: any) => e.id === gw)?.data_checked ?? false;
  },
};