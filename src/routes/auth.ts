import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { prisma } from "../utils/prisma";
import { fplService } from "../services/fpl";
import { claimPendingMemberships } from "../services/leagueImport";
import { authenticate, AuthRequest } from "../middleware/authenticate";
import {
  checkAccountStanding,
  DEFAULT_REFUSAL,
  DEFAULT_REFUSAL_STATUS,
} from "../services/accountStatus";
import { trialEndFrom } from "../services/entitlements";
import { AppError } from "../utils/AppError";

export const authRouter = Router();

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  displayName: z.string().min(2).max(30),
});

authRouter.post("/register", async (req, res, next) => {
  try {
    const body = registerSchema.parse(req.body);
    const exists = await prisma.user.findUnique({ where: { email: body.email } });

    // A blocked email cannot come back through the front door. Said plainly,
    // because "email already registered" would invite them to try a reset.
    if (exists && exists.status === "BLOCKED") {
      throw new AppError("This email cannot be used to register.", 403);
    }
    if (exists) throw new AppError("Email already registered", 409);

    const passwordHash = await bcrypt.hash(body.password, 12);
    const user = await prisma.user.create({
      data: {
        email: body.email,
        passwordHash,
        displayName: body.displayName,
        // Analysis free for a fortnight, starting now. Stored rather than
        // computed from createdAt so extending somebody's trial is one field
        // edit, and so changing the rule later cannot silently rewrite what
        // existing accounts were already promised.
        trialEndsAt: trialEndFrom(),
      },
    });

    const token = sign(user.id);
    res.status(201).json({ token, user: safe(user) });
  } catch (e) { next(e); }
});

authRouter.post("/login", async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !(await bcrypt.compare(password, user.passwordHash)))
      throw new AppError("Invalid email or password", 401);

    // Checked here as well as in the middleware, so a suspended manager is told
    // why at the point they try to sign in rather than seeing a blank app that
    // fails on its first request.
    const standing = await checkAccountStanding(user.id);
    if (!standing.ok) {
      throw new AppError(
        standing.message || DEFAULT_REFUSAL,
        standing.httpStatus || DEFAULT_REFUSAL_STATUS
      );
    }

    res.json({ token: sign(user.id), user: safe(user) });
  } catch (e) { next(e); }
});

authRouter.post("/link-fpl", authenticate, async (req: AuthRequest, res, next) => {
  try {
    const { fplTeamId } = req.body;
    if (!fplTeamId) throw new AppError("FPL team ID required");

    const taken = await prisma.user.findFirst({
      where: { fplTeamId: Number(fplTeamId), id: { not: req.userId } },
    });
    if (taken) throw new AppError("FPL team already linked to another account", 409);

    const team = await fplService.getTeam(Number(fplTeamId));
    if (!team) throw new AppError("FPL team not found — check your manager ID", 404);

    const user = await prisma.user.update({
      where: { id: req.userId },
      data: {
        fplTeamId: Number(fplTeamId),
        fplTeamName: team.name,
        fplVerifiedAt: new Date(),
      },
    });

    // Place them into any imported mini-league that was waiting for this team.
    claimPendingMemberships(req.userId!, Number(fplTeamId)).catch((e) =>
      console.error("[import] claiming pending memberships failed", e)
    );

    res.json({ message: `Team "${team.name}" linked`, user: safe(user) });
  } catch (e) { next(e); }
});

authRouter.get("/me", authenticate, async (req: AuthRequest, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user) throw new AppError("Not found", 404);
    res.json(safe(user));
  } catch (e) { next(e); }
});

function sign(userId: string) {
  return jwt.sign({ userId }, process.env.JWT_SECRET as string, { expiresIn: "30d" });
}
/**
 * What the client is allowed to see of a user row.
 *
 * statusNote is an admin's private note and statusById names another account —
 * neither has any business leaving the server, so both are stripped here rather
 * than relying on every route to remember.
 */
function safe(u: any) {
  const { passwordHash, statusNote, statusById, ...rest } = u;
  return rest;
}