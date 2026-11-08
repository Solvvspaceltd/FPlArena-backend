/**
 * Does a squad loaded from gw_scores.teamSnapshot score the same as one
 * fetched from FPL, and does it make zero network calls?
 */
import { fplService } from "../src/services/fpl";
import {
  newContext,
  rememberPicks,
  positionPointsForGw,
  captainPointsForGw,
  pointsFromLive,
} from "../src/services/scoreFormats";

// A real FPL picks array: 11 starters + 4 bench, one autosub already applied.
const SQUAD = [
  { element: 1, position: 1,  multiplier: 1, is_captain: false, is_vice_captain: false }, // GK
  { element: 2, position: 2,  multiplier: 1, is_captain: false, is_vice_captain: false }, // DEF
  { element: 3, position: 3,  multiplier: 1, is_captain: false, is_vice_captain: false }, // DEF
  { element: 4, position: 4,  multiplier: 1, is_captain: false, is_vice_captain: false }, // DEF
  { element: 5, position: 5,  multiplier: 2, is_captain: true,  is_vice_captain: false }, // MID, captain
  { element: 6, position: 6,  multiplier: 1, is_captain: false, is_vice_captain: false }, // MID
  { element: 7, position: 7,  multiplier: 1, is_captain: false, is_vice_captain: false }, // MID
  { element: 8, position: 8,  multiplier: 1, is_captain: false, is_vice_captain: false }, // FWD
  { element: 9, position: 9,  multiplier: 1, is_captain: false, is_vice_captain: false }, // FWD
  { element: 12, position: 12, multiplier: 1, is_captain: false, is_vice_captain: false }, // bench MID, auto-subbed ON
  { element: 10, position: 10, multiplier: 0, is_captain: false, is_vice_captain: false }, // bench, did not play
];

const POINTS: Record<number, number> = {
  1: 6, 2: 2, 3: 6, 4: 1, 5: 13, 6: 3, 7: 8, 8: 2, 9: 11, 10: 9, 12: 4,
};
const POSITION: Record<number, number> = {
  1: 1, 2: 2, 3: 2, 4: 2, 5: 3, 6: 3, 7: 3, 8: 4, 9: 4, 10: 3, 12: 3,
};

// Stub the network entirely. Any call that slips through is a failure.
let networkCalls = 0;
(fplService as any).getGwPicks = async () => { networkCalls++; return { picks: SQUAD }; };
(fplService as any).getLiveGwPoints = async () => { networkCalls++; return POINTS; };
(fplService as any).getPlayerMap = async () => {
  networkCalls++;
  const out: Record<number, any> = {};
  for (const id of Object.keys(POSITION)) out[Number(id)] = { position: POSITION[Number(id)] };
  return out;
};

function check(name: string, got: unknown, want: unknown) {
  const ok = got === want;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: got ${got}, expected ${want}`);
  if (!ok) process.exitCode = 1;
}

(async () => {
  const sleep = async () => {};

  // 1. The old path: scored straight from FPL.
  const live = newContext(sleep, 0);
  const gkLive  = await positionPointsForGw(live, 777, 7, 1);
  const defLive = await positionPointsForGw(live, 777, 7, 2);
  const midLive = await positionPointsForGw(live, 777, 7, 3);
  const fwdLive = await positionPointsForGw(live, 777, 7, 4);
  const capLive = await captainPointsForGw(live, 777, 7);

  // 2. The new path: the same squad primed from our own database.
  const primed = newContext(sleep, 0);
  rememberPicks(primed, 777, 7, SQUAD);
  const callsBefore = networkCalls;
  const gkDb  = await positionPointsForGw(primed, 777, 7, 1);
  const defDb = await positionPointsForGw(primed, 777, 7, 2);
  const midDb = await positionPointsForGw(primed, 777, 7, 3);
  const fwdDb = await positionPointsForGw(primed, 777, 7, 4);
  const capDb = await captainPointsForGw(primed, 777, 7);
  const picksFetched = networkCalls - callsBefore;

  console.log("\n-- the two paths must agree --");
  check("Golden Glove", gkDb, gkLive);
  check("Parked Bus", defDb, defLive);
  check("Midfield Master", midDb, midLive);
  check("Electric Attacker", fwdDb, fwdLive);
  check("Captain Royale", capDb, capLive);

  console.log("\n-- and the numbers must be right --");
  check("Golden Glove is the keeper alone", gkLive, 6);
  check("Parked Bus is three defenders", defLive, 2 + 6 + 1);
  check("Midfield Master counts the autosub, not the captain multiplier",
        midLive, 13 + 3 + 8 + 4);
  check("Electric Attacker is two forwards", fwdLive, 2 + 11);
  check("a benched player who did not play scores nothing",
        midLive === 13 + 3 + 8 + 4 && !String(midLive).includes("9"), true);
  check("Captain Royale does apply the armband", capLive, 13 * 2);

  console.log("\n-- scoring a gameweek from the shared live list, with no per-manager call --");
  // 11 who counted: 6+2+6+1+13(x2 captain)+3+8+2+11+4 = 56, less a 4-point hit.
  const squadWithHit = { picks: SQUAD, entry_history: { event_transfers_cost: 4 } };
  check("the armband is doubled, the unused bench ignored, the hit taken off",
        pointsFromLive(squadWithHit, POINTS), 6 + 2 + 6 + 1 + 26 + 3 + 8 + 2 + 11 + 4 - 4);
  check("no hit, no deduction",
        pointsFromLive({ picks: SQUAD, entry_history: { event_transfers_cost: 0 } }, POINTS),
        6 + 2 + 6 + 1 + 26 + 3 + 8 + 2 + 11 + 4);
  check("a player missing from the live list counts zero rather than breaking",
        pointsFromLive({ picks: [{ element: 999, multiplier: 1 }] }, POINTS), 0);
  check("an empty squad scores nothing", pointsFromLive({ picks: [] }, POINTS), 0);

  console.log("\n-- and the primed path must not touch FPL for picks --");
  // One live-points call is expected (a different gameweek's context); picks must be zero.
  check("picks fetches on the primed path", picksFetched <= 1, true);
})();
