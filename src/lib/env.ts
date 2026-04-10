import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

function loadIfExists(filePath: string): void {
  if (fs.existsSync(filePath)) {
    dotenv.config({ path: filePath, override: false });
  }
}

function loadDatabaseUrlFromEnvFile(envFile: string): void {
  if (!fs.existsSync(envFile)) {
    return;
  }

  const parsed = dotenv.parse(fs.readFileSync(envFile));
  const databaseUrl = parsed.DATABASE_URL?.trim();
  if (databaseUrl) {
    process.env.DATABASE_URL = databaseUrl;
  }
}

function loadEnvironment(): void {
  const cwd = process.cwd();
  const envFile = path.join(cwd, '.env');
  const envLocalFile = path.join(cwd, '.env.local');

  // In production (including Docker), prefer .env/injected environment.
  if (process.env.NODE_ENV === 'production') {
    loadIfExists(envFile);
    loadDatabaseUrlFromEnvFile(envFile);
    return;
  }

  // In local development, prefer .env.local and fall back to .env for missing keys.
  loadIfExists(envLocalFile);
  loadIfExists(envFile);
  loadDatabaseUrlFromEnvFile(envFile);
}

loadEnvironment();
