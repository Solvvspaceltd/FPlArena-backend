import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { AppError } from "../utils/AppError";

export interface AuthRequest extends Request { userId?: string; userRole?: string; }

export function authenticate(req: AuthRequest, _res: Response, next: NextFunction) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return next(new AppError("Authentication required", 401));
  try {
    const decoded: any = jwt.verify(auth.slice(7), process.env.JWT_SECRET as string);
    req.userId = decoded.userId;
    req.userRole = decoded.role;
    next();
  } catch { next(new AppError("Invalid or expired token", 401)); }
}