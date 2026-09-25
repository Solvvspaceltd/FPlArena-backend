/**
 * The pack: the thirty managers above you on Clashd and the thirty below.
 *
 * Global ownership is close to useless. "6% owned" tells you nothing if the
 * people you are actually racing all have him. What matters is what the sixty
 * managers nearest you own that you do not — and, crucially, the same player
 * means opposite things in each direction:
 *
 *   Against the thirty ABOVE, you need what they do not have. If you both own
 *   Haaland and he hauls, the gap is unchanged. Only a differential closes it.
 *
 *   Against the thirty BELOW, you need what they DO have. Owning the same
 *   players makes a lead safe whatever happens.
 *
 * So one list of "differentials" is the wrong shape. Four signals come out of
 * it instead — see the four builders at the bottom.
 *
 * No FPL calls: squad_snapshots already holds every linked manager's picks for
 * the gameweek (captured by asideJobs once the deadline passes), and this reads
 * from that plus the projection model.
 */
import { prisma } from "../utils/prisma";
import { getProjections, PlayerForecast } from "./projections";

const WINDOW = 30; // either side

export interface DiffPlayer {
  id: number;
  name: string;
  team: string;
  pos: "GK" | "DEF" | "MID" | "FWD";
  price: number;
  xp: number;            // forecast over the horizon
  next: number;          // forecast next gameweek
  status: string;
  ownedAbove: number;
  ownedBelow: number;
  ownedPack: number;     // of the whole sixty
  /** Rarity-weighted upside against the managers ahead of you. */
  separation: number;
}

const POS: Record<number, DiffPlayer["pos"]> = { 1: "GK", 2: "DEF", 3: "MID", 4: "FWD" };

export async function packDifferentials(userId: string) {
  const me = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, totalPoints: true, displayName: true, platformRank: true },
  });
  if (!me) return null;

  // The window. Sliding rather than fixed: a manager in 3rd has no thirty
  // above, and should still see a full sixty rather than a truncated picture.
  const above = await prisma.user.findMany({
    where: { fplTeamId: { not: null }, id: { not: userId }, totalPoints: { gte: me.totalPoints } },
    orderBy: { totalPoints: "asc" },
    take: WINDOW,
    select: { id: true, displayName: true, fplTeamName: true, totalPoints: true },
  });
  const below = await prisma.user.findMany({
    where: { fplTeamId: { not: null }, id: { not: userId }, totalPoints: { lt: me.totalPoints } },
    orderBy: { totalPoints: "desc" },
    take: WINDOW + (WINDOW - above.length), // borrow the shortfall downwards
    select: { id: true, displayName: true, fplTeamName: true, totalPoints: true },
  });
  const extraAbove = below.length < WINDOW
    ? await prisma.user.findMany({
        where: {
          fplTeamId: { not: null },
          id: { notIn: [userId, ...above.map((u) => u.id)] },
          totalPoints: { gte: me.totalPoints },
        },
        orderBy: { totalPoints: "asc" },
        skip: above.length,
        take: WINDOW - below.length,
        select: { id: true, displayName: true, fplTeamName: true, totalPoints: true },
      })
    : [];
  const aboveAll = [...above, ...extraAbove];

  if (aboveAll.length + below.length < 4) return { ready: false as const, reason: "Not enough managers on Clashd yet." };

  // Latest gameweek we have squads for.
  const latest = await prisma.squadSnapshot.findFirst({
    orderBy: { gameweek: "desc" },
    select: { gameweek: true },
  });
  if (!latest) return { ready: false as const, reason: "Squads are captured after the first deadline." };
  const gameweek = latest.gameweek;

  const ids = [userId, ...aboveAll.map((u) => u.id), ...below.map((u) => u.id)];
  const snaps = await prisma.squadSnapshot.findMany({
    where: { gameweek, userId: { in: ids } },
    select: { userId: true, picks: true },
  });

  const squadOf = new Map<string, number[]>();
  for (const s of snaps) {
    const picks = Array.isArray(s.picks) ? (s.picks as any[]) : [];
    squadOf.set(s.userId, picks.map((p) => Number(p.element)).filter(Number.isFinite));
  }

  const mine = new Set(squadOf.get(userId) || []);
  if (!mine.size) return { ready: false as const, reason: "Your squad has not been captured yet." };

  const countIn = (users: { id: string }[]) => {
    const c = new Map<number, number>();
    let sampled = 0;
    for (const u of users) {
      const sq = squadOf.get(u.id);
      if (!sq?.length) continue;
      sampled++;
      for (const el of new Set(sq)) c.set(el, (c.get(el) || 0) + 1);
    }
    return { c, sampled };
  };

  const A = countIn(aboveAll);
  const B = countIn(below);
  const nAbove = Math.max(1, A.sampled);
  const nBelow = Math.max(1, B.sampled);
  const nPack = A.sampled + B.sampled;

  const proj = await getProjections();

  const build = (el: number): DiffPlayer | null => {
    const f: PlayerForecast | undefined = proj.players[el];
    if (!f) return null;
    const ownedAbove = A.c.get(el) || 0;
    const ownedBelow = B.c.get(el) || 0;
    return {
      id: el,
      name: f.name,
      team: f.teamShort,
      pos: POS[f.pos] || "MID",
      price: f.price,
      xp: Math.round(f.total * 10) / 10,
      next: Math.round(f.next * 10) / 10,
      status: f.status,
      ownedAbove,
      ownedBelow,
      ownedPack: ownedAbove + ownedBelow,
      // Upside you can actually gain on the people ahead: forecast points
      // discounted by how many of them already hold him.
      separation: Math.round(f.total * (1 - ownedAbove / nAbove) * 10) / 10,
    };
  };

  const everyone = new Set<number>([...A.c.keys(), ...B.c.keys(), ...mine]);
  const all = Array.from(everyone).map(build).filter(Boolean) as DiffPlayer[];
  const notMine = all.filter((p) => !mine.has(p.id) && p.status === "a");
  const isMine = all.filter((p) => mine.has(p.id));

  /* ── the four signals ─────────────────────────────────────────────── */

  // Bleeding: the pack has him, you do not. Not clever, just costly.
  const bleeding = notMine
    .filter((p) => p.ownedPack / Math.max(1, nPack) >= 0.5)
    .sort((a, b) => b.ownedPack * b.xp - a.ownedPack * a.xp)
    .slice(0, 6);

  // Catch-up: rare among those ahead, forecast well. This is where separation
  // against the people beating you comes from.
  const catchUp = notMine
    .filter((p) => p.ownedAbove / nAbove <= 0.25 && p.xp > 0)
    .sort((a, b) => b.separation - a.separation)
    .slice(0, 12);

  // Exposure: common below you, not yours. This is how you get overtaken.
  const exposure = notMine
    .filter((p) => p.ownedBelow / nBelow >= 0.4)
    .sort((a, b) => b.ownedBelow * b.xp - a.ownedBelow * a.xp)
    .slice(0, 6);

  // Your edge: already yours, and rare in the pack.
  const edge = isMine
    .filter((p) => p.ownedPack / Math.max(1, nPack) <= 0.25)
    .sort((a, b) => b.xp - a.xp)
    .slice(0, 6);

  /* ── the differential XI ──────────────────────────────────────────── */

  const byPos = (pos: DiffPlayer["pos"], n: number) =>
    catchUp.filter((p) => p.pos === pos).slice(0, n);

  const xi = {
    GK: byPos("GK", 2),
    DEF: byPos("DEF", 3),
    MID: byPos("MID", 3),
    FWD: byPos("FWD", 3),
  };

  /* ── the headline ─────────────────────────────────────────────────── */

  const pick = catchUp[0] || null;
  let headline: { player: string; message: string; leapfrog: number } | null = null;
  if (pick) {
    // He is forecast `xp` and the managers ahead who do not own him gain
    // nothing from it, so the gap closes by roughly that much.
    const gaps = aboveAll
      .filter((u) => !(squadOf.get(u.id) || []).includes(pick.id))
      .map((u) => u.totalPoints - me.totalPoints)
      .filter((g) => g > 0);
    const leapfrog = gaps.filter((g) => g <= pick.xp).length;
    headline = {
      player: pick.name,
      leapfrog,
      message:
        `${pick.name} is owned by ${pick.ownedAbove} of the ${nAbove} managers above you. ` +
        `He is forecast ${pick.xp} points over the next ${proj.horizon} gameweeks — ` +
        (leapfrog > 0
          ? `more than the gap to ${leapfrog} of them.`
          : `not yet enough to close the gap to anyone above, but it is the widest margin available to you.`),
    };
  }

  return {
    ready: true as const,
    gameweek,
    window: { above: A.sampled, below: B.sampled },
    you: { name: me.displayName, points: me.totalPoints, rank: me.platformRank },
    headline,
    bleeding,
    catchUp,
    exposure,
    edge,
    xi,
  };
}
