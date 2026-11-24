#!/usr/bin/env node
/**
 * Applique les migrations Drizzle.
 * Usage : npm run db:migrate
 */
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

if (!process.env.DATABASE_URL && existsSync('.env.local')) {
  // Charge .env.local manuellement (Node ne le fait pas tout seul < v20.6).
  const { readFileSync } = await import('node:fs');
  const text = readFileSync('.env.local', 'utf8');
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  }
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL manquant. Copie .env.example en .env.local.');
  process.exit(1);
}

try {
  execSync('npx drizzle-kit push --force', { stdio: 'inherit' });
  console.log('\x1b[32m[migrate]\x1b[0m schéma appliqué.');
} catch (e) {
  console.error('\x1b[31m[migrate]\x1b[0m échec.');
  process.exit(1);
}
