import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { prisma } from "../utils/prisma";
import { fplService } from "../services/fpl";
import { authenticate, AuthRequest } from "../middleware/authenticate";
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
    if (exists) throw new AppError("Email already registered", 409);

    const passwordHash = await bcrypt.hash(body.password, 12);
    const user = await prisma.user.create({
      data: { email: body.email, passwordHash, displayName: body.displayName },
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
function safe(u: any) {
  const { passwordHash, ...rest } = u;
  return rest;
}