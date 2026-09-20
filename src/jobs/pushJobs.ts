import cron from "node-cron";
import { prisma } from "../utils/prisma";
import { fplService } from "../services/fpl";
import { buildPlan } from "../services/plan";
import { sendOnce, usersWithDevices } from "../services/push";

/**
 * Scheduled pushes. One pass every fifteen minutes decides what is due:
 *
 *   24 hours before a deadline   reminder that the plan is ready
 *   2 hours before a deadline    the match forecast and our captain pick
 *   up to 36 hours before        captain flagged as a doubt
 *   once a gameweek is checked   head-to-head result, and top scorer
 *
 * Each alert is keyed (for example "deadline2:6"), and sendOnce() refuses a
 * key it has already sent, so overlapping runs and restarts are harmless.
 */

let started = false;
let running = false;

export function startPushJobs() {
  if (started || process.env.PUSH_JOBS === "off") return;
  started = true;
  cron.schedule("*/15 * * * *", () => {
    runPushCycle().catch((e) => console.error("[push] cycle failed", e));
  });
  console.log("[push] jobs scheduled");
}

function londonTime(iso: string) {
  try {
    return new Date(iso).toLocaleTimeString("en-GB", {
      timeZone: "Europe/London", hour: "2-digit", minute: "2-digit",
    });
  } catch (e) {
    return "";
  }
}

// A user's captain at the last deadline. Picks cannot change after a deadline,
// so one fetch per user per gameweek is enough.
const captainCache = new Map<string, number | null>();
async function lastCaptain(fplTeamId: number, gw: number) {
  const key = fplTeamId + ":" + gw;
  if (captainCache.has(key)) return captainCache.get(key) ?? null;
  const picks = await fplService.getGwPicks(fplTeamId, gw).catch(() => null);
  const cap = picks?.picks?.find((p: any) => p.is_captain)?.element ?? null;
  captainCache.set(key, cap);
  return cap;
}

export async function runPushCycle(now = Date.now()) {
  if (running) return;
  running = true;
  try {
    const users = await usersWithDevices();
    if (!users.length) return;

    const next = await fplService.getNextGameweek().catch(() => null);
    if (next?.deadline) {
      const hours = (new Date(next.deadline).getTime() - now) / 3600000;
      if (hours > 23.5 && hours <= 24.5) await deadlineDayBefore(users, next.id, next.deadline);
      if (hours > 1.5 && hours <= 2.25) await deadlineTwoHours(users, next.id);
      if (hours > 1 && hours <= 36) await captainDoubts(users, next.id);
    }
    await results(users);
  } finally {
    running = false;
  }
}

async function deadlineDayBefore(users: string[], gw: number, deadline: string) {
  const at = londonTime(deadline);
  for (const userId of users) {
    await sendOnce(userId, `deadline24:${gw}`, "deadline",
      `Gameweek ${gw} deadline tomorrow`,
      `Deadline ${at ? "is " + at + " tomorrow" : "is tomorrow"}. Your match forecast and captain pick are ready.`,
      { screen: "plan" });
  }
}

async function deadlineTwoHours(users: string[], gw: number) {
  // One at a time: each plan reads a squad and its rivals from FPL.
  for (const userId of users) {
    let body = "Last chance for transfers and your captain.";
    try {
      const plan: any = await buildPlan(userId);
      if (plan?.ready && plan.match) {
        const m = plan.match;
        body = `Forecast: you ${Math.round(m.me)}, ${m.opponent} ${Math.round(m.them)}.`;
        if (plan.captain?.pick?.name) body += ` Our captain pick: ${plan.captain.pick.name}.`;
      } else if (plan?.ready && plan.captain?.pick?.name) {
        body = `Our captain pick for you: ${plan.captain.pick.name}.`;
      }
    } catch (e) { /* send the plain version */ }
    await sendOnce(userId, `deadline2:${gw}`, "deadline",
      `Gameweek ${gw} deadline in 2 hours`, body, { screen: "plan" });
  }
}

async function captainDoubts(users: string[], gw: number) {
  const boot = await fplService.getBootstrap().catch(() => null);
  if (!boot) return;
  const els: Record<number, any> = {};
  for (const e of boot.elements || []) els[e.id] = e;

  const rows = await prisma.user.findMany({
    where: { id: { in: users }, fplTeamId: { not: null } },
    select: { id: true, fplTeamId: true },
  });
  for (const u of rows) {
    const cap = await lastCaptain(u.fplTeamId!, gw - 1);
    if (!cap) continue;
    const el = els[cap];
    if (!el) continue;
    const chance = el.chance_of_playing_next_round;
    const doubtful = el.status !== "a" || (chance != null && chance < 75);
    if (!doubtful) continue;

    let alt = "";
    try {
      const plan: any = await buildPlan(u.id);
      const pick = (plan?.captain?.list || []).find((c: any) => c.id !== cap);
      if (pick) {
        alt = plan.match
          ? ` Next best against ${plan.match.opponent}: ${pick.name}.`
          : ` Next best by forecast: ${pick.name}.`;
      }
    } catch (e) { /* send without the alternative */ }

    const flag = el.news
      ? String(el.news).replace(/\.$/, "")
      : chance != null ? `Flagged ${chance}% to play` : "Flagged as a doubt";
    await sendOnce(u.id, `capdoubt:${gw}:${cap}`, "captain",
      `${el.web_name} is ${chance === 0 ? "ruled out" : "a doubt"}`,
      `${flag}. He was your captain last gameweek.${alt}`,
      { screen: "plan" });
  }
}

async function results(users: string[]) {
  const gw = await fplService.getCurrentGameweek().catch(() => null);
  if (!gw) return;
  const finished = await fplService.isGwFinished(gw).catch(() => false);
  if (!finished) return;
  const userSet = new Set(users);

  // Head-to-head results, once each fixture has been settled.
  const fixtures = await prisma.fixture.findMany({
    where: { gameweek: gw, settled: true },
    include: {
      division: { select: { name: true } },
      homeEntry: { include: { user: { select: { id: true, displayName: true, fplTeamName: true } } } },
      awayEntry: { include: { user: { select: { id: true, displayName: true, fplTeamName: true } } } },
    },
  });
  for (const f of fixtures) {
    if (!f.awayEntry) continue;
    const sides = [
      { me: f.homeEntry, them: f.awayEntry, mine: f.homePoints ?? 0, theirs: f.awayPoints ?? 0 },
      { me: f.awayEntry, them: f.homeEntry, mine: f.awayPoints ?? 0, theirs: f.homePoints ?? 0 },
    ];
    for (const s of sides) {
      const uid = s.me.user.id;
      if (!userSet.has(uid)) continue;
      const opp = s.them.user.fplTeamName || s.them.user.displayName;
      const div = f.division?.name ? ` in ${f.division.name}` : "";
      const body = s.mine > s.theirs
        ? `You beat ${opp} ${s.mine}-${s.theirs}${div}.`
        : s.mine < s.theirs
          ? `${opp} beat you ${s.theirs}-${s.mine}${div}.`
          : `You drew with ${opp} ${s.mine}-${s.theirs}${div}.`;
      const title = s.mine > s.theirs ? `Gameweek ${gw}: a win` : s.mine < s.theirs ? `Gameweek ${gw}: a defeat` : `Gameweek ${gw}: a draw`;
      await sendOnce(uid, `result:${gw}`, "results", title, body, { screen: "leagues" });
    }
  }

  // Top scorer across Clashd.
  const scores = await prisma.gwScore.findMany({
    where: { gameweek: gw },
    select: { points: true, entry: { select: { userId: true } } },
  });
  if (!scores.length) return;
  const best = new Map<string, number>();
  for (const r of scores) best.set(r.entry.userId, Math.max(best.get(r.entry.userId) ?? -99, r.points));
  const top = Math.max(...Array.from(best.values()));
  if (top <= 0) return;
  for (const [uid, pts] of best.entries()) {
    if (pts !== top || !userSet.has(uid)) continue;
    await sendOnce(uid, `gwtop:${gw}`, "results",
      `Top of Clashd in Gameweek ${gw}`,
      `Your ${pts} was the highest score on Clashd this gameweek.`,
      { screen: "home" });
  }
}
