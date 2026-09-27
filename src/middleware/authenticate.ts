import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { AppError } from "../utils/AppError";
import {
  checkAccountStanding,
  DEFAULT_REFUSAL,
  DEFAULT_REFUSAL_STATUS,
} from "../services/accountStatus";

export interface AuthRequest extends Request { userId?: string; userRole?: string; }

/**
 * Verify the token, then check the account is still allowed to act.
 *
 * The second half is new and it is the reason this is now async. Tokens last 30
 * days, so without a per-request check a suspended manager would keep playing
 * until their token expired. The check is cached for 30 seconds and invalidated
 * the moment an admin changes a status, so in practice it costs nothing and
 * takes effect at once. See services/accountStatus.ts.
 *
 * A non-active account gets 403, not 401. The distinction matters to the app: a
 * 401 sends somebody back to the login screen to try again, which is exactly the
 * wrong thing to do when the password was never the problem.
 */
export async function authenticate(req: AuthRequest, _res: Response, next: NextFunction) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return next(new AppError("Authentication required", 401));

  let decoded: any;
  try {
    decoded = jwt.verify(auth.slice(7), process.env.JWT_SECRET as string);
  } catch {
    return next(new AppError("Invalid or expired token", 401));
  }

  req.userId = decoded.userId;
  req.userRole = decoded.role;

  const standing = await checkAccountStanding(decoded.userId);
  if (!standing.ok) {
    return next(
      new AppError(
        standing.message || DEFAULT_REFUSAL,
        standing.httpStatus || DEFAULT_REFUSAL_STATUS
      )
    );
  }

  next();
}
