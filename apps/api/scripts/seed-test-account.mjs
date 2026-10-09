import { PrismaClient } from '@prisma/client';
import { randomBytes, scrypt as nodeScrypt } from 'node:crypto';
import { promisify } from 'node:util';

if (process.env.NODE_ENV === 'production') {
  throw new Error('Test account seeding is disabled in production.');
}
if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required. Configure apps/api/.env first.');
}

const email = (process.env.TEST_ACCOUNT_EMAIL ?? 'demo@rentflow.local').trim().toLowerCase();
const password = process.env.TEST_ACCOUNT_PASSWORD ?? 'RentFlowDemo!2026';
const organizationSlug = 'rentflow-demo';
const scrypt = promisify(nodeScrypt);
const prisma = new PrismaClient();

async function hashPassword(value) {
  const salt = randomBytes(16);
  const derived = await scrypt(value, salt, 64);
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

try {
  const passwordHash = await hashPassword(password);
  await prisma.$transaction(async (tx) => {
    const organization = await tx.organization.upsert({
      where: { slug: organizationSlug },
      // The shared demo login must work without an authenticator app.
      update: { name: 'RentFlow Demo', status: 'ACTIVE', requireOwnerMfa: false },
      create: {
        name: 'RentFlow Demo',
        slug: organizationSlug,
        receiptPrefix: 'DEMO',
        requireOwnerMfa: false,
        receiptSequence: { create: {} },
      },
    });
    await tx.receiptSequence.upsert({
      where: { organizationId: organization.id },
      update: {},
      create: { organizationId: organization.id },
    });
    const user = await tx.user.upsert({
      where: { email },
      update: {
        displayName: 'Demo Owner',
        passwordHash,
        disabledAt: null,
        emailVerifiedAt: new Date(),
      },
      create: {
        email,
        displayName: 'Demo Owner',
        passwordHash,
        emailVerifiedAt: new Date(),
      },
    });
    await tx.membership.upsert({
      where: {
        organizationId_userId: {
          organizationId: organization.id,
          userId: user.id,
        },
      },
      update: { role: 'OWNER', status: 'ACTIVE', joinedAt: new Date() },
      create: {
        organizationId: organization.id,
        userId: user.id,
        role: 'OWNER',
        status: 'ACTIVE',
        joinedAt: new Date(),
      },
    });
    await tx.session.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  });
  console.log('Development test account is ready.');
  console.log(`Email: ${email}`);
  console.log(`Password: ${password}`);
} finally {
  await prisma.$disconnect();
}
