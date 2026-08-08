import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');

  // Create admin user
  const adminHash = await bcrypt.hash('Admin@FPLArena2024', 12);
  const admin = await prisma.user.upsert({
    where: { email: 'admin@fplarena.com' },
    update: {},
    create: {
      email: 'admin@fplarena.com',
      passwordHash: adminHash,
      displayName: 'FPLArena Admin',
      role: 'ADMIN',
      over18Confirmed: true,
    },
  });

  console.log(`✅ Admin user: ${admin.email}`);

  // Create the opening beta league
  const league = await prisma.league.upsert({
    where: { inviteCode: 'ARENA-BETA1' },
    update: {},
    create: {
      name: 'FPLArena Beta League 2024/25',
      type: 'SEASON_OVERALL',
      inviteCode: 'ARENA-BETA1',
      maxEntries: 50,
      startGameweek: 1,
      endGameweek: 38,
      description: 'The official FPLArena beta season league. Top 3 win prizes.',
      prizeInfo: '1st: £100 | 2nd: £50 | 3rd: £25',
      entryFeeInfo: '£10 per player — pay via bank transfer to admin',
      status: 'OPEN',
      createdById: admin.id,
    },
  });

  console.log(`✅ Beta league: ${league.name} (code: ${league.inviteCode})`);

  // Create a weekly GW league
  const gwLeague = await prisma.league.upsert({
    where: { inviteCode: 'ARENA-WEEK1' },
    update: {},
    create: {
      name: 'Weekly Gameweek Cup — GW1',
      type: 'WEEKLY_GW',
      inviteCode: 'ARENA-WEEK1',
      maxEntries: 50,
      startGameweek: 1,
      endGameweek: 1,
      targetGameweek: 1,
      description: 'Highest GW score wins the weekly pot.',
      prizeInfo: 'Winner takes £40 | Runner-up £20 | 3rd £10',
      entryFeeInfo: '£5 per player',
      status: 'OPEN',
      createdById: admin.id,
    },
  });

  console.log(`✅ GW league: ${gwLeague.name} (code: ${gwLeague.inviteCode})`);
  console.log('\n🏆 Seed complete!');
  console.log('Admin login: admin@fplarena.com / Admin@FPLArena2024');
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
