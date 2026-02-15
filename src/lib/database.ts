import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { createChildLogger } from './logger';

const log = createChildLogger('database');

const databaseUrl = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/janus';

const pool = new Pool({ connectionString: databaseUrl });
const adapter = new PrismaPg(pool);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const prisma = new PrismaClient({ adapter } as any);

export async function connectDatabase(): Promise<void> {
  log.info('Connecting to PostgreSQL...');
  await prisma.$connect();
  log.info('PostgreSQL connected');
}

export async function disconnectDatabase(): Promise<void> {
  log.info('Disconnecting from PostgreSQL...');
  await prisma.$disconnect();
  await pool.end();
  log.info('PostgreSQL disconnected');
}
