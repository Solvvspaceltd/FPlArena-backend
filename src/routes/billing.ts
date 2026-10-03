/**
 * Billing.
 *
 * RevenueCat sits in front of both stores. It tells us what somebody owns
 * through the webhook below, and that webhook is the only thing that grants
 * access. The app never posts "I am Pro now" and gets believed.
 *
 *   GET  /api/billing/me                what this account holds, and the prices
 *   GET  /api/billing/club/:leagueId    the band and price for that league
 *   POST /api/billing/club              the app reports a Club purchase it made
 *   POST /api/billing/revenuecat        the webhook (RevenueCat calls this)
 *   POST /api/billing/comp              admin grants or revokes access
 */
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../utils/prisma";
import { AppError } from "../utils/AppError";
import { authenticate, AuthRequest } from "../middleware/authenticate";
import { requireAdmin } from "../middleware/requireAdmin";
import {
  getEntitlement, freePreview, PRO_PRODUCTS, CLUB_PRODUCTS,
  clubBandFor, isProProduct, isClubProduct,
} from "../services/entitlements";
import { sendOnce } from "../services/push";

export const billingRouter = Router();

const money = (pence: number) =>
  pence % 100 === 0 ? `£${pence / 100}` : `£${(pence / 100).toFixed(2)}`;

/* ── what this account holds ─────────────────────────────────────────── */

billingRouter.get("/me", authenticate, async (req: AuthRequest, res, next) => {
  try {
    const ent = await getEntitlement(req.userId!);
    res.json({
      ...ent,
      preview: freePreview(),
      plans: [
        { productId: "clashd_pro_monthly", name: "Clashd Analysis", period: "month",
          price: money(PRO_PRODUCTS.clashd_pro_monthly.pence), pence: 299 },
        { productId: "clashd_pro_yearly", name: "Clashd Analysis", period: "year",
          price: money(PRO_PRODUCTS.clashd_pro_yearly.pence), pence: 2999,
          note: "Two months free against the monthly price", trialDays: 7 },
      ],
      club: Object.entries(CLUB_PRODUCTS).map(([productId, b]) => ({
        productId, seats: b.seats, price: money(b.pence), pence: b.pence,
      })),
    });
  } catch (err) { next(err); }
});

/* ── what a Club pass costs for one league ───────────────────────────── */

billingRouter.get("/club/:leagueId", authenticate, async (req: AuthRequest, res, next) => {
  try {
    const league = await prisma.league.findUnique({
      where: { id: req.params.leagueId },
      select: { id: true, name: true, season: true, createdById: true, _count: { select: { entries: true } } },
    });
    if (!league) throw new AppError("League not found", 404);

    const managers = league._count.entries;
    const band = clubBandFor(managers);
    const existing = await prisma.clubPass.findUnique({
      where: { leagueId_season: { leagueId: league.id, season: league.season } },
    });

    res.json({
      leagueId: league.id,
      leagueName: league.name,
      season: league.season,
      managers,
      canBuy: league.createdById === req.userId,
      band: band
        ? { productId: band.productId, seats: band.seats, price: money(band.pence), pence: band.pence }
        : null,
      tooLarge: !band,
      active: existing && !existing.cancelledAt && existing.activeUntil > new Date()
        ? { seats: existing.seats, activeUntil: existing.activeUntil, productId: existing.productId }
        : null,
    });
  } catch (err) { next(err); }
});

/* ── the app reports a Club purchase ─────────────────────────────────────
   Recorded unverified. The webhook flips verified to true when RevenueCat
   confirms the same transaction, so a faked call grants nothing lasting. */

const clubBody = z.object({
  leagueId: z.string().uuid(),
  productId: z.string(),
  transactionId: z.string(),
  store: z.enum(["APP_STORE", "PLAY_STORE"]).default("APP_STORE"),
});

billingRouter.post("/club", authenticate, async (req: AuthRequest, res, next) => {
  try {
    const body = clubBody.parse(req.body);
    if (!isClubProduct(body.productId)) throw new AppError("Not a Club product", 400);

    const league = await prisma.league.findUnique({
      where: { id: body.leagueId },
      select: { id: true, season: true, createdById: true, importGroupId: true },
    });
    if (!league) throw new AppError("League not found", 404);

    // Any member of the group may pay for it, not only whoever imported it.
    // The person who set the league up is often not the one who would happily
    // cover it, and a league dying because one specific person did not pay is a
    // worse outcome than anyone in it being allowed to.
    const member = await prisma.entry.findFirst({
      where: { userId: req.userId!, leagueId: league.id },
      select: { id: true },
    });
    if (!member && league.createdById !== req.userId) {
      throw new AppError("You have to be in this league to buy its Club pass", 403);
    }

    const pass = await upsertClubPass({
      leagueId: league.id,
      season: league.season,
      productId: body.productId,
      transactionId: body.transactionId,
      store: body.store,
      purchasedById: req.userId!,
      verified: false,
    });

    res.status(201).json({ ok: true, pass });
  } catch (err) { next(err); }
});

/* ── the webhook ──────────────────────────────────────────────────────── */

billingRouter.post("/revenuecat", async (req, res, next) => {
  try {
    const secret = process.env.REVENUECAT_WEBHOOK_SECRET;
    if (!secret) throw new AppError("Billing webhook is not configured", 503);

    // Compare forgivingly. A shared secret copied between two dashboards picks
    // up trailing whitespace, a newline, or a "Bearer " prefix somebody added
    // out of habit, and none of those are a real signature failure. What is
    // left after trimming still has to match exactly.
    const sent = String(req.headers.authorization || "")
      .trim()
      .replace(/^Bearer\s+/i, "");
    const want = String(secret).trim().replace(/^Bearer\s+/i, "");
    if (!sent || sent !== want) throw new AppError("Bad webhook signature", 401);

    const event = req.body?.event;
    if (!event?.id || !event?.type) throw new AppError("Malformed webhook body", 400);

    // Idempotent: RevenueCat retries, and a retry must not extend anybody twice.
    const seen = await prisma.billingEvent.findUnique({ where: { eventId: event.id } });
    if (seen) return res.json({ ok: true, duplicate: true });

    const userId: string | null = event.app_user_id ?? null;
    const productId: string | null = event.product_id ?? null;
    const store: string | null = event.store ?? null;
    const expiresAt = event.expiration_at_ms ? new Date(Number(event.expiration_at_ms)) : null;

    await prisma.billingEvent.create({
      data: {
        eventId: event.id,
        type: event.type,
        userId: userId && (await userExists(userId)) ? userId : null,
        productId, store,
        environment: event.environment ?? null,
        expiresAt,
        payload: req.body,
      },
    });

    if (userId && (await userExists(userId))) {
      if (isClubProduct(productId)) {
        await applyClubEvent(event, userId, productId!);
      } else if (isProProduct(productId)) {
        await applyProEvent(event, userId, productId!, store, expiresAt);
      }
    }

    res.json({ ok: true });
  } catch (err) { next(err); }
});

async function userExists(id: string) {
  return !!(await prisma.user.findUnique({ where: { id }, select: { id: true } }));
}

const GRANTS = new Set([
  "INITIAL_PURCHASE", "RENEWAL", "UNCANCELLATION", "PRODUCT_CHANGE",
  "NON_RENEWING_PURCHASE", "TRANSFER", "SUBSCRIPTION_EXTENDED",
]);
const ENDS = new Set(["EXPIRATION", "REFUND", "SUBSCRIPTION_PAUSED"]);

async function applyProEvent(
  event: any, userId: string, productId: string, store: string | null, expiresAt: Date | null
) {
  const source = store === "PLAY_STORE" ? "GOOGLE" : "APPLE";

  if (GRANTS.has(event.type)) {
    await prisma.user.update({
      where: { id: userId },
      data: {
        proUntil: expiresAt,
        proSource: source as any,
        proProductId: productId,
        proWillRenew: true,
      },
    });
    return;
  }

  // Cancelled but paid up: they keep it until the period ends, and we stop
  // telling them it renews.
  if (event.type === "CANCELLATION") {
    await prisma.user.update({ where: { id: userId }, data: { proWillRenew: false } });
    return;
  }

  if (ENDS.has(event.type)) {
    await prisma.user.update({
      where: { id: userId },
      data: { proUntil: null, proSource: "NONE" as any, proProductId: null, proWillRenew: false },
    });
  }
}

async function applyClubEvent(event: any, userId: string, productId: string) {
  // Which league? The app sets this as a RevenueCat subscriber attribute just
  // before it starts the purchase; if that is missing we fall back to the
  // unverified row the app posted to /club.
  const attr = event.subscriber_attributes?.clashd_club_league?.value as string | undefined;
  const txId = String(event.transaction_id ?? event.id);

  if (event.type === "REFUND" || event.type === "EXPIRATION") {
    await prisma.clubPass.updateMany({
      where: { transactionId: txId },
      data: { cancelledAt: new Date() },
    });
    return;
  }
  if (!GRANTS.has(event.type)) return;

  const pending = await prisma.clubPass.findFirst({
    where: { purchasedById: userId, productId, verified: false },
    orderBy: { createdAt: "desc" },
  });
  const leagueId = attr ?? pending?.leagueId;
  if (!leagueId) return; // nothing to attach it to; the audit row is still stored

  const league = await prisma.league.findUnique({
    where: { id: leagueId }, select: { id: true, season: true },
  });
  if (!league) return;

  await upsertClubPass({
    leagueId: league.id,
    season: league.season,
    productId,
    transactionId: txId,
    store: event.store === "PLAY_STORE" ? "PLAY_STORE" : "APP_STORE",
    purchasedById: userId,
    verified: true,
  });

  // The payment is banked. Restarting the suite and filling in the gameweeks it
  // missed happens after we have replied: a webhook that waits on several FPL
  // round trips is a webhook that times out and gets retried, and the retry
  // would do all of this again.
  restartAfterPayment(league.id).catch((e) =>
    console.error("[club] restart after payment failed", e)
  );
}

/**
 * Bring a paid-for suite back to life.
 *
 * Deliberately separate from the webhook's own work so a slow catch-up can
 * never cause a payment to be recorded twice. If this fails, the suite is still
 * marked paid and the next live sync scores it going forward; only the gap
 * remains, and an admin can re-run it.
 */
async function restartAfterPayment(leagueId: string) {
  const league = await prisma.league.findUnique({
    where: { id: leagueId },
    select: { importGroupId: true },
  });
  if (!league?.importGroupId) return;

  const { fplService } = await import("../services/fpl");
  const { unfreezeGroup } = await import("../services/leagueAccess");
  const { syncScores } = await import("../jobs/fplSync");

  const currentGw = await fplService.getCurrentGameweek();
  if (!currentGw) return;

  const res = await unfreezeGroup(league.importGroupId, currentGw);
  if (!res) return;

  console.log(
    `[club] restarted ${res.leagues} competitions, backfilling ${res.missedGameweeks.length} gameweeks`
  );

  // Ascending, ending on the live gameweek. Order matters: weekly formats set
  // their total from the gameweek being scored, so the last pass has to be the
  // current one or the table would show an old week's score as the standing.
  for (const gw of res.missedGameweeks) {
    try {
      await syncScores(gw);
    } catch (e) {
      console.error(`[club] backfill of GW${gw} failed`, e);
    }
  }
}

/** A Club pass runs to the end of the season it was bought in: 30 June. */
function seasonEnd(season: string) {
  const startYear = Number(String(season).slice(0, 4));
  const year = Number.isFinite(startYear) ? startYear + 1 : new Date().getFullYear() + 1;
  return new Date(Date.UTC(year, 5, 30, 23, 59, 59));
}

async function upsertClubPass(p: {
  leagueId: string; season: string; productId: string; transactionId: string;
  store: string; purchasedById: string; verified: boolean;
}) {
  const band = CLUB_PRODUCTS[p.productId];
  if (!band) throw new AppError("Unknown Club product", 400);

  return prisma.clubPass.upsert({
    where: { leagueId_season: { leagueId: p.leagueId, season: p.season } },
    create: {
      leagueId: p.leagueId,
      season: p.season,
      seats: band.seats,
      amountPence: band.pence,
      productId: p.productId,
      transactionId: p.transactionId,
      store: p.store,
      purchasedById: p.purchasedById,
      activeUntil: seasonEnd(p.season),
      verified: p.verified,
    },
    update: {
      seats: band.seats,
      amountPence: band.pence,
      productId: p.productId,
      transactionId: p.transactionId,
      store: p.store,
      activeUntil: seasonEnd(p.season),
      cancelledAt: null,
      ...(p.verified ? { verified: true } : {}),
    },
  });
}

/* ── comps ────────────────────────────────────────────────────────────── */

billingRouter.post("/comp", authenticate, requireAdmin, async (req: AuthRequest, res, next) => {
  try {
    const body = z.object({
      userId: z.string().uuid(),
      grant: z.boolean(),
      until: z.string().datetime().optional(),
    }).parse(req.body);

    await prisma.user.update({
      where: { id: body.userId },
      data: body.grant
        ? { proSource: "COMP" as any, proUntil: body.until ? new Date(body.until) : null,
            proProductId: null, proWillRenew: false }
        : { proSource: "NONE" as any, proUntil: null, proProductId: null, proWillRenew: false },
    });
    res.json({ ok: true, entitlement: await getEntitlement(body.userId) });
  } catch (err) { next(err); }
});

/* -- one-off trial backfill ----------------------------------------------
   Every account from the free preview has trialEndsAt = null, because nothing
   ever set it: access came from CLASHD_FREE_PREVIEW instead. The second that
   flag goes false those accounts have no trial, no subscription and no comp,
   so every one of them hits the paywall at once with no warning.

   Idempotent by construction: it only writes rows where trialEndsAt is still
   null, so running it twice cannot extend anybody twice. Run it BEFORE
   flipping the flag, never after.                                          */

const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];
const longDate = (d: Date) => `${d.getDate()} ${MONTHS[d.getMonth()]}`;

billingRouter.post("/trial-backfill", authenticate, requireAdmin, async (req: AuthRequest, res, next) => {
  try {
    const body = z.object({
      days: z.number().int().min(1).max(365).default(30),
      dryRun: z.boolean().default(true),
      notify: z.boolean().default(false),
    }).parse(req.body ?? {});

    const now = new Date();
    const until = new Date(now.getTime() + body.days * 86_400_000);

    const candidates = await prisma.user.findMany({
      where: {
        trialEndsAt: null,
        status: "ACTIVE" as any,
        deletedAt: null,
        OR: [{ proUntil: null }, { proUntil: { lte: now } }],
      },
      select: { id: true, email: true, displayName: true, fplTeamName: true },
      orderBy: { createdAt: "asc" },
    });

    if (body.dryRun) {
      return res.json({
        dryRun: true, days: body.days, until, count: candidates.length,
        users: candidates.map((u) => ({
          id: u.id, email: u.email, name: u.fplTeamName || u.displayName,
        })),
      });
    }

    const written = await prisma.user.updateMany({
      where: { id: { in: candidates.map((u) => u.id) }, trialEndsAt: null },
      data: { trialEndsAt: until },
    });

    let notified = 0;
    if (body.notify) {
      for (const u of candidates) {
        const ok = await sendOnce(
          u.id,
          "trial-backfill-" + until.toISOString().slice(0, 10),
          "results",
          `Analysis is yours until ${longDate(until)}`,
          `Analysis has been free while Clashd was in preview. It is a paid product from now on, and your account keeps it free for another ${body.days} days.`,
          { screen: "ANALYSIS" },
        ).catch(() => false);
        if (ok) notified++;
      }
    }

    res.json({ ok: true, days: body.days, until, granted: written.count, notified });
  } catch (err) { next(err); }
});
