import { Router } from "express";
import { prisma } from "../utils/prisma";
import { authenticate, AuthRequest } from "../middleware/authenticate";
import { requireAdmin } from "../middleware/requireAdmin";
import { AppError } from "../utils/AppError";
import { fplService } from "../services/fpl";

export const newsRouter = Router();

/**
 * The News feed: admin-written Clashd posts plus official FPL player news
 * (injuries, suspensions, availability) taken from bootstrap-static.
 *
 * FPL news is read-only and needs no scraping or third-party feed, so there is
 * nothing to maintain and nothing that can go stale on our side.
 */
newsRouter.get("/", authenticate, async (_req: AuthRequest, res, next) => {
  try {
    const [posts, fpl] = await Promise.allSettled([
      prisma.post.findMany({
        orderBy: [{ pinned: "desc" }, { createdAt: "desc" }],
        take: 30,
        include: { author: { select: { displayName: true } } },
      }),
      fplService.getPlayerNews(30),
    ]);

    const clashd =
      posts.status === "fulfilled"
        ? posts.value.map((p) => ({
            id: p.id,
            kind: "CLASHD" as const,
            title: p.title,
            body: p.body,
            category: p.category,
            pinned: p.pinned,
            author: p.author?.displayName || "Clashd",
            at: p.createdAt,
          }))
        : [];

    const fplNews =
      fpl.status === "fulfilled"
        ? fpl.value.map((n: any) => ({
            id: n.id,
            kind: "FPL" as const,
            title: n.player + " (" + n.team + ")",
            body: n.news,
            chance: n.chance,
            pinned: false,
            at: n.at,
          }))
        : [];

    res.json({
      items: [...clashd, ...fplNews],
      fplAvailable: fpl.status === "fulfilled",
    });
  } catch (e) {
    next(e);
  }
});

/** Create a post. Admin only. */
newsRouter.post("/", authenticate, requireAdmin, async (req: AuthRequest, res, next) => {
  try {
    const { title, body, category, pinned } = req.body as any;
    if (!title || !String(title).trim()) return next(new AppError("Title is required.", 400));
    if (!body || !String(body).trim()) return next(new AppError("Body is required.", 400));

    const post = await prisma.post.create({
      data: {
        title: String(title).trim().slice(0, 140),
        body: String(body).trim().slice(0, 4000),
        category: category ? String(category).toUpperCase().slice(0, 20) : "CLASHD",
        pinned: !!pinned,
        authorId: req.userId!,
      },
    });

    res.status(201).json({ message: "Post published.", post });
  } catch (e) {
    next(e);
  }
});

/** Delete a post. Admin only. */
newsRouter.delete("/:id", authenticate, requireAdmin, async (req: AuthRequest, res, next) => {
  try {
    const post = await prisma.post.findUnique({ where: { id: req.params.id } });
    if (!post) return next(new AppError("Post not found.", 404));
    await prisma.post.delete({ where: { id: post.id } });
    res.json({ message: "Post deleted." });
  } catch (e) {
    next(e);
  }
});
