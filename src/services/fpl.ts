import axios from "axios";

const api = axios.create({
  baseURL: process.env.FPL_API_BASE || "https://fantasy.premierleague.com/api",
  timeout: 15000,
  headers: { "User-Agent": "FPLArena/2.0" },
});

export const fplService = {
  async getTeam(teamId: number) {
    try {
      const { data } = await api.get(`/entry/${teamId}/`);
      return data;
    } catch (e: any) {
      if (e.response?.status === 404) return null;
      throw e;
    }
  },

  async getGwPicks(teamId: number, gw: number) {
    try {
      const { data } = await api.get(`/entry/${teamId}/event/${gw}/picks/`);
      return data;
    } catch (e: any) {
      if (e.response?.status === 404) return null;
      throw e;
    }
  },

  async getHistory(teamId: number) {
    const { data } = await api.get(`/entry/${teamId}/history/`);
    return data;
  },

  async getBootstrap() {
    const { data } = await api.get("/bootstrap-static/");
    return data;
  },

  async getCurrentGameweek(): Promise<number | null> {
    const b = await this.getBootstrap();
    return b.events.find((e: any) => e.is_current)?.id ?? null;
  },

  async isGwFinished(gw: number): Promise<boolean> {
    const b = await this.getBootstrap();
    return b.events.find((e: any) => e.id === gw)?.data_checked ?? false;
  },
};