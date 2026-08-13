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
import { errorHandler } from "./middleware/errorHandler";
import { setupSocket } from "./services/socket";
import { startSyncJobs } from "./jobs/fplSync";
import { startAsideJobs } from "./jobs/asideJobs";

const app = express();
const httpServer = createServer(app);

export const io = new IO(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

app.use(helmet());
app.use(cors({ origin: "*", credentials: true }));
app.use(express.json());

app.use("/api/auth", authRouter);
app.use("/api/leagues", leaguesRouter);
app.use("/api/users", usersRouter);
app.use("/api/notifications", notificationsRouter);
app.use("/api/admin", adminRouter);
app.use("/api/aside", asideRouter);

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