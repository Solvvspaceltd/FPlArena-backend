import { Server } from "socket.io";
import jwt from "jsonwebtoken";

export function setupSocket(io: Server) {
  io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error("Auth required"));
    try {
      const decoded: any = jwt.verify(token, process.env.JWT_SECRET as string);
      socket.data.userId = decoded.userId;
      next();
    } catch { next(new Error("Invalid token")); }
  });

  io.on("connection", (socket) => {
    socket.join(`user:${socket.data.userId}`);
    socket.on("join:league", (id: string) => socket.join(`league:${id}`));
    socket.on("leave:league", (id: string) => socket.leave(`league:${id}`));
    socket.on("disconnect", () => {});
  });
}