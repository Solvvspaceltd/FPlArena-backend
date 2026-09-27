import express from "express";
import cors from "cors";
import helmet from "helmet";
import dotenv from "dotenv";
import { createServer } from "http";
import { Server as IO } from "socket.io";

dotenv.config();

import { authRouter } from "./routes/auth";
import { leaguesRouter } from "./routes/leagues";
import { usersRouter } from "./routes/users";
import { notificationsRouter } from "./routes/notifications";
import { adminRouter } from "./routes/admin";
import { asideRouter } from "./routes/aside";
import { fplRouter } from "./routes/fpl";
import { newsRouter } from "./routes/news";
import { divisionsRouter } from "./routes/divisions";
import { summaryRouter } from "./routes/summary";
import { analysisRouter } from "./routes/analysis";
import { importRouter } from "./routes/import";
import { billingRouter } from "./routes/billing";
import { errorHandler } from "./middleware/errorHandler";
import { apiLimiter, authLimiter, webhookLimiter } from "./middleware/rateLimiter";
import { setupSocket } from "./services/socket";
import { startSyncJobs } from "./jobs/fplSync";
import { startAsideJobs } from "./jobs/asideJobs";

const app = express();
const httpServer = createServer(app);

/**
 * Railway terminates TLS and forwards to this process, so the socket address
 * is always Railway's. Without this, every request looks like it comes from
 * one IP and the rate limiter would throttle the entire user base together the
 * moment anybody hit a limit. One hop, not `true` — trusting every proxy header
 * lets a caller forge X-Forwarded-For and walk straight past the limiter.
 */
app.set("trust proxy", 1);

/**
 * Who may call this API from a browser.
 *
 * It was "*", which let any website on the internet read responses from this
 * API in a visitor's browser. The exposure was limited because sessions are
 * Bearer tokens rather than cookies, so another site cannot ride an existing
 * session — but there is no reason to allow it either.
 *
 * `!origin` is allowed deliberately and must stay: the iOS app, server to
 * server calls and the RevenueCat webhook send no Origin header at all.
 * Refusing those would take the whole app down.
 */
const ORIGINS = (process.env.CORS_ORIGINS ||
  "https://playclashd.com,https://www.playclashd.com,http://localhost:3000,http://localhost:5173,http://localhost:8080"
).split(",").map((s) => s.trim()).filter(Boolean);

function originAllowed(origin: string | undefined, cb: (e: Error | null, ok?: boolean) => void) {
  if (!origin) return cb(null, true);          // native app, curl, webhooks
  if (ORIGINS.includes(origin)) return cb(null, true);
  return cb(null, false);                      // refused, not thrown: a rejected
                                               // preflight should be a clean CORS
                                               // failure, not a 500 in the logs
}

export const io = new IO(httpServer, {
  cors: { origin: ORIGINS, methods: ["GET", "POST"] },
});

app.use(helmet());
app.use(cors({ origin: originAllowed, credentials: true }));

// An explicit ceiling. The default is 100kb; saying so means a later change to
// the default cannot quietly widen it.
app.use(express.json({ limit: "200kb" }));

/**
 * Rate limiting.
 *
 * The strict limiter goes on the sign-in and registration paths BEFORE the
 * router, so it runs whatever the router does internally. The loose one covers
 * everything else. This was written months ago and never mounted, which meant
 * unlimited password guessing against a public API.
 */
app.use("/api/auth/login", authLimiter);
app.use("/api/auth/register", authLimiter);
app.use("/api/billing/revenuecat", webhookLimiter);
app.use("/api", apiLimiter);

app.use("/api/auth", authRouter);
app.use("/api/leagues", leaguesRouter);
app.use("/api/users", usersRouter);
app.use("/api/notifications", notificationsRouter);
app.use("/api/admin", adminRouter);
app.use("/api/aside", asideRouter);
app.use("/api/fpl", fplRouter);
app.use("/api/news", newsRouter);
app.use("/api/divisions", divisionsRouter);
app.use("/api/summary", summaryRouter);
app.use("/api/analysis", analysisRouter);
app.use("/api/import", importRouter);
app.use("/api/billing", billingRouter);

app.get("/health", (_req, res) => res.json({
  status: "ok",
  service: "FPLArena API v2",
  timestamp: new Date().toISOString(),
}));

app.use(errorHandler);

setupSocket(io);
if (process.env.NODE_ENV !== "test") {
  startSyncJobs();
  startAsideJobs();
}

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`FPLArena API running on :${PORT}`);
});

export default app;
