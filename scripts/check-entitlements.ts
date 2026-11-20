/**
 * Who holds Clashd Analysis, and on what grounds.
 *
 * The case that matters most is the one that broke: an account that was
 * comped, then subscribed, then let the subscription lapse. Before the
 * `comped` field existed, the purchase overwrote the comp and the lapse
 * destroyed it, putting a comped tester behind the paywall.
 */
import { decideEntitlement, ProFields } from "../src/services/entitlements";

const NOW = new Date("2026-11-20T12:00:00Z");
const PAST = new Date("2026-11-05T12:00:00Z");
const FUTURE = new Date("2026-12-20T12:00:00Z");

function account(over: Partial<ProFields> = {}): ProFields {
  return {
    proUntil: null, proSource: "NONE", proProductId: null,
    proWillRenew: false, trialEndsAt: null, comped: false, ...over,
  };
}

let failed = 0;
function check(name: string, user: ProFields, wantPro: boolean, wantSource: string) {
  const got = decideEntitlement(user, NOW);
  const pro = got ? got.pro : false;
  const source = got ? got.source : "NONE";
  const ok = pro === wantPro && source === wantSource;
  if (!ok) failed++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}\n        got pro=${pro} source=${source}` +
    (ok ? "" : `, expected pro=${wantPro} source=${wantSource}`)
  );
}

console.log("-- the bug that started this --");
check("comped, subscribed, then the subscription lapsed",
  account({ comped: true, proSource: "APPLE", proUntil: PAST }), true, "COMP");
check("comped, and the sandbox lapse wrote NONE over the top",
  account({ comped: true, proSource: "NONE", proUntil: null }), true, "COMP");

console.log("\n-- paying managers --");
check("a live subscription",
  account({ proSource: "APPLE", proUntil: FUTURE, proWillRenew: true }), true, "APPLE");
check("comped AND paying is reported as paying, because they are",
  account({ comped: true, proSource: "APPLE", proUntil: FUTURE }), true, "APPLE");
check("a lapsed subscription with nothing behind it",
  account({ proSource: "APPLE", proUntil: PAST }), false, "NONE");

console.log("\n-- comps --");
check("a comp granted the new way",
  account({ comped: true }), true, "COMP");
check("a comp granted before the field existed",
  account({ proSource: "COMP", proUntil: null }), true, "COMP");
check("a comp with an end date that has passed",
  account({ proSource: "COMP", proUntil: PAST, comped: false }), false, "NONE");
check("a revoked comp sees the paywall, which is the point of revoking",
  account({ comped: false, proSource: "NONE", trialEndsAt: new Date(0) }), false, "NONE");

console.log("\n-- the free fortnight --");
check("a new account inside its trial",
  account({ trialEndsAt: FUTURE }), true, "TRIAL");
check("a trial that has run out",
  account({ trialEndsAt: PAST }), false, "NONE");
check("an account from the preview, which never had a trial set",
  account({ trialEndsAt: null }), false, "NONE");
check("paying during the trial reports as paying, not as a trialist",
  account({ trialEndsAt: FUTURE, proSource: "APPLE", proUntil: FUTURE }), true, "APPLE");

console.log("\n-- a Club pass is not Analysis --");
check("CLUB never grants Analysis on its own",
  account({ proSource: "CLUB", proUntil: FUTURE }), false, "NONE");

console.log(failed ? `\n${failed} FAILED` : "\nAll cases pass.");
process.exit(failed ? 1 : 0);
