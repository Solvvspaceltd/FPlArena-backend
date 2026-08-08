import { Router } from "express";
import { prisma } from "../utils/prisma";
import { authenticate, AuthRequest } from "../middleware/authenticate";

export const notificationsRouter = Router();

notificationsRouter.get("/", authenticate, async (req: AuthRequest, res, next) => {
  try {
    const notifs = await prisma.notification.findMany({
      where: { userId: req.userId! },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    res.json(notifs);
  } catch (e) { next(e); }
});

notificationsRouter.patch("/read-all", authenticate, async (req: AuthRequest, res, next) => {
  try {
    await prisma.notification.updateMany({
      where: { userId: req.userId!, read: false },
      data: { read: true },
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

notificationsRouter.patch("/:id/read", authenticate, async (req: AuthRequest, res, next) => {
  try {
    await prisma.notification.update({
      where: { id: req.params.id },
      data: { read: true },
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});