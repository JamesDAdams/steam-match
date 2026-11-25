import fs from 'node:fs';
if (fs.existsSync('.env.local')) process.loadEnvFile('.env.local');
import { createServer } from 'vite';
const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
try {
  const m = await vite.ssrLoadModule('/lib/events-sync.ts');
  try {
    const r = await m.syncDiscordEventsIfStale(0);
    console.log('resultat:', JSON.stringify(r));
  } catch (e) {
    console.log('ERREUR:', e.message);
    console.log(e.stack?.split('\n').slice(0, 4).join('\n'));
  }
  const { getDb } = await vite.ssrLoadModule('/db/index.ts');
  const { sql } = await import('drizzle-orm');
  const rows = await getDb().execute(sql`SELECT id, name, synced_at FROM discord_events`);
  console.log('lignes restantes:', (rows.rows ?? rows).length);
} finally { await vite.close(); }
