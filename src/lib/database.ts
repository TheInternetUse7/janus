import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { createChildLogger } from './logger';

const log = createChildLogger('database');

const databaseUrl = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/janus';

const adapter = new PrismaPg({ connectionString: databaseUrl });
export const prisma = new PrismaClient({ adapter });

export async function connectDatabase(): Promise<void> {
  log.info('Connecting to PostgreSQL...');
  await prisma.$connect();
  log.info('PostgreSQL connected');
}

export async function disconnectDatabase(): Promise<void> {
  log.info('Disconnecting from PostgreSQL...');
  await prisma.$disconnect();
  log.info('PostgreSQL disconnected');
}
