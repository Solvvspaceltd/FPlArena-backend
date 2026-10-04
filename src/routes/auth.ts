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
import crypto from "crypto";
import { requireAdmin } from "../middleware/requireAdmin";

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

/* -- passwords ------------------------------------------------------------
   Until now there was no way to change a password, for a manager or for an
   admin, and the app's "forgot password" link opened a mailto to support that
   support had no tool to answer. The first person to forget theirs after
   launch had no route back into their account.

   There is no mail sender in this service, so this deliberately does not need
   one. Somebody who knows their password changes it themselves. Somebody who
   does not gets a one-time code from an admin and types it into the app. When
   email is wired up later, /reset/issue is the only thing that has to change.

     POST /api/auth/password        change your own, knowing the current one
     POST /api/auth/reset/issue     admin: mint a one-time code for somebody
     POST /api/auth/reset/confirm   use a code to set a new password

   These sit under /api/auth, so authLimiter already covers them.           */

/** Crockford base32, without the characters people mistype. */
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_TTL_MINUTES = 60;

function newCode() {
  const bytes = crypto.randomBytes(10);
  let out = "";
  for (let i = 0; i < 10; i++) out += CODE_ALPHABET[bytes[i] % 32];
  return out.slice(0, 5) + "-" + out.slice(5);
}

/** Accepts what somebody actually types: spaces, lower case, I for 1, O for 0. */
function normaliseCode(raw: string) {
  return String(raw || "")
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
}

function hashCode(code: string) {
  return crypto.createHash("sha256").update(normaliseCode(code)).digest("hex");
}

authRouter.post("/password", authenticate, async (req: AuthRequest, res, next) => {
  try {
    const body = z.object({
      currentPassword: z.string().min(1),
      newPassword: z.string().min(8).max(200),
    }).parse(req.body);

    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user) throw new AppError("Not found", 404);

    if (!(await bcrypt.compare(body.currentPassword, user.passwordHash))) {
      throw new AppError("That is not your current password.", 401);
    }
    if (await bcrypt.compare(body.newPassword, user.passwordHash)) {
      throw new AppError("That is the password you already have.", 400);
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await bcrypt.hash(body.newPassword, 12),
        passwordChangedAt: new Date(),
      },
    });

    res.json({ message: "Password changed." });
  } catch (e) { next(e); }
});

authRouter.post("/reset/issue", authenticate, requireAdmin, async (req: AuthRequest, res, next) => {
  try {
    const body = z.object({ email: z.string().email() }).parse(req.body);

    const user = await prisma.user.findUnique({ where: { email: body.email } });
    if (!user) throw new AppError("No account with that email.", 404);
    if (user.status === "BLOCKED") {
      throw new AppError("That account is blocked. Unblock it first.", 403);
    }

    // Any code already outstanding for this account is spent, so there is only
    // ever one live code per person.
    await prisma.passwordReset.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: new Date() },
    });

    const code = newCode();
    const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60000);
    await prisma.passwordReset.create({
      data: {
        userId: user.id,
        tokenHash: hashCode(code),
        expiresAt,
        issuedById: req.userId,
      },
    });

    // Returned once, to the admin who asked. Nothing stores the code itself.
    res.json({
      code,
      expiresAt,
      minutes: CODE_TTL_MINUTES,
      forEmail: user.email,
      forName: user.fplTeamName || user.displayName,
    });
  } catch (e) { next(e); }
});

authRouter.post("/reset/confirm", async (req, res, next) => {
  try {
    const body = z.object({
      email: z.string().email(),
      code: z.string().min(4).max(32),
      newPassword: z.string().min(8).max(200),
    }).parse(req.body);

    const user = await prisma.user.findUnique({ where: { email: body.email } });
    const row = await prisma.passwordReset.findUnique({
      where: { tokenHash: hashCode(body.code) },
    });

    // One message for every failure, so this cannot be used to discover which
    // emails have accounts or which codes exist.
    const bad = new AppError("That code is not valid, or it has expired.", 400);
    if (!user || !row) throw bad;
    if (row.userId !== user.id) throw bad;
    if (row.usedAt) throw bad;
    if (row.expiresAt <= new Date()) throw bad;

    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: {
          passwordHash: await bcrypt.hash(body.newPassword, 12),
          passwordChangedAt: new Date(),
        },
      }),
      prisma.passwordReset.update({
        where: { id: row.id },
        data: { usedAt: new Date() },
      }),
    ]);

    res.json({ message: "Password set. Sign in with it now." });
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