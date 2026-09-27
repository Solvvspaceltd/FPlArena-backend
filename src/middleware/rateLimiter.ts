/**
 * Rate limiting.
 *
 * The API is the public front door and always will be: the phone app and the
 * website both have to reach it from anywhere. So the limits here are not
 * defence in depth, they are the defence.
 *
 * Two tiers, because the endpoints have very different risk:
 *
 *   apiLimiter    Everything. Generous, aimed at a runaway client or a scraper,
 *                 not at an attacker. A real user on a busy gameweek makes a
 *                 lot of requests and must never hit this.
 *
 *   authLimiter   Sign-in and registration only. Tight, because this is where
 *                 passwords get guessed. Successful sign-ins are not counted,
 *                 so somebody legitimately signing in on four devices is
 *                 unaffected while somebody guessing gets ten tries.
 *
 * On the count: ten failures per quarter hour per IP makes an online guessing
 * attack useless. An attacker with a botnet gets more attempts, which is why
 * this is not the only control - it buys time, and the audit log and account
 * status give you somewhere to act from.
 */
import rateLimit from "express-rate-limit";

/** Everything under /api. Deliberately loose. */
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  message: { error: "Too many requests. Wait a moment and try again." },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Sign-in and registration. Only failures count towards the limit, so the
 * person who mistypes once and then gets it right never notices this exists.
 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  message: {
    error: "Too many sign-in attempts. Wait fifteen minutes and try again.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * The RevenueCat webhook. It authenticates with a shared secret rather than a
 * session, and a payment provider retrying in a burst is normal traffic, so it
 * gets its own generous limit rather than being caught by the auth one.
 */
export const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: { error: "Too many requests" },
  standardHeaders: true,
  legacyHeaders: false,
});

/** Kept so any existing import of the old name still resolves. */
export const rateLimiter = apiLimiter;
