import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

function loadIfExists(filePath: string): void {
  if (fs.existsSync(filePath)) {
    dotenv.config({ path: filePath, override: false });
  }
}

function loadEnvironment(): void {
  const cwd = process.cwd();
  const envFile = path.join(cwd, '.env');
  const envLocalFile = path.join(cwd, '.env.local');

  // In production (including Docker), prefer .env/injected environment.
  if (process.env.NODE_ENV === 'production') {
    loadIfExists(envFile);
    return;
  }

  // In local development, prefer .env.local and fall back to .env for missing keys.
  loadIfExists(envLocalFile);
  loadIfExists(envFile);
}

loadEnvironment();
