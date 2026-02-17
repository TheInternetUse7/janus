import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';
import { defineConfig } from 'prisma/config';

function loadIfExists(filePath: string): void {
  if (fs.existsSync(filePath)) {
    dotenv.config({ path: filePath, override: false });
  }
}

const cwd = process.cwd();
const envFile = path.join(cwd, '.env');
const envLocalFile = path.join(cwd, '.env.local');

if (process.env.NODE_ENV === 'production') {
  loadIfExists(envFile);
} else {
  loadIfExists(envLocalFile);
  loadIfExists(envFile);
}

export default defineConfig({
  schema: path.join(__dirname, 'prisma', 'schema.prisma'),
  datasource: {
    url:
      process.env.DIRECT_URL ||
      process.env.DATABASE_URL ||
      'postgresql://postgres:postgres@localhost:5432/janus',
  },
});
