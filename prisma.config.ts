import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';
import { defineConfig } from 'prisma/config';

function getDatabaseUrlFromEnvFile(): string {
  const envFile = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envFile)) {
    throw new Error('Missing .env file');
  }

  const parsed = dotenv.parse(fs.readFileSync(envFile));
  const databaseUrl = parsed.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error('Missing DATABASE_URL in .env');
  }

  process.env.DATABASE_URL = databaseUrl;
  return databaseUrl;
}

const databaseUrl = getDatabaseUrlFromEnvFile();

export default defineConfig({
  schema: path.join(__dirname, 'prisma', 'schema.prisma'),
  datasource: {
    url: databaseUrl,
  },
});
