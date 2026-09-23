import { Response, NextFunction } from "express";
import { AuthRequest } from "./authenticate";
import { AppError } from "../utils/AppError";
import { getEntitlement } from "../services/entitlements";

/**
 * Gate for anything that is part of Clashd Analysis.
 *
 * Put this after authenticate. It attaches the entitlement to the request so
 * the handler can mention the source ("your club pass runs to May") without
 * looking it up a second time.
 */
export async function requirePro(req: AuthRequest, _res: Response, next: NextFunction) {
  try {
    if (!req.userId) return next(new AppError("Authentication required", 401));
    const ent = await getEntitlement(req.userId);
    (req as any).entitlement = ent;
    if (!ent.pro) {
      return next(new AppError("Clashd Analysis is not active on this account", 402));
    }
    next();
  } catch (err) { next(err); }
}

/**
 * Same lookup, but never blocks. Use it where a screen should still render
 * with the free half and mark the rest as locked.
 */
export async function attachEntitlement(req: AuthRequest, _res: Response, next: NextFunction) {
  try {
    if (req.userId) (req as any).entitlement = await getEntitlement(req.userId);
    next();
  } catch (err) { next(err); }
}
