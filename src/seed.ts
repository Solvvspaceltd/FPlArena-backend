import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  console.log("Seeding...");

  // Create admin user
  const admin = await prisma.user.upsert({
    where: { email: "admin@fplarena.com" },
    update: {},
    create: {
      email: "admin@fplarena.com",
      passwordHash: await bcrypt.hash("admin123!", 12),
      displayName: "FPLArena Admin",
      role: "ADMIN",
    },
  });

  // Create a sample league
  const league = await prisma.league.upsert({
    where: { inviteCode: "ARENA-BETA1" },
    update: {},
    create: {
      name: "FPLArena Beta League 2024/25",
      inviteCode: "ARENA-BETA1",
      season: "2024/25",
      startGameweek: 1,
      endGameweek: 38,
      status: "ACTIVE",
      prizeInfo: "Winner takes all — agreed outside the app",
      description: "The inaugural FPLArena beta league. Welcome!",
      createdById: admin.id,
    },
  });

  console.log("Admin:", admin.email);
  console.log("Beta league invite code:", league.inviteCode);
  console.log("Done!");
}

main().catch(console.error).finally(() => prisma.$disconnect());