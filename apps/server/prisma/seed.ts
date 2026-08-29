/**
 * Local dev seed: `npm run db:seed`.
 * In containers the same baseline roles are ensured at startup by SeedService.
 */
import { PrismaClient } from '@prisma/client';
import { BUILTIN_ROLES } from '@cerebro/shared';

const prisma = new PrismaClient();

async function main() {
  for (const role of Object.values(BUILTIN_ROLES)) {
    await prisma.role.upsert({
      where: { slug: role.slug },
      update: {
        name: role.name,
        description: role.description,
        permissions: role.permissions,
        builtin: true,
      },
      create: {
        slug: role.slug,
        name: role.name,
        description: role.description,
        permissions: role.permissions,
        builtin: true,
      },
    });
    console.log(`[seed] ensured role: ${role.slug}`);
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
