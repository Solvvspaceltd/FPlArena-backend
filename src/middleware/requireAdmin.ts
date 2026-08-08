import { Response, NextFunction } from "express";
import { AuthRequest } from "./authenticate";
import { prisma } from "../utils/prisma";
import { AppError } from "../utils/AppError";

export async function requireAdmin(req: AuthRequest, _res: Response, next: NextFunction) {
  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  if (!user || user.role !== "ADMIN") return next(new AppError("Admin only", 403));
  next();
}