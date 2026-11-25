import fs from 'node:fs';
if (fs.existsSync('.env.local')) process.loadEnvFile('.env.local');
import { createServer } from 'vite';
const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
try {
  const { getDb } = await vite.ssrLoadModule('/db/index.ts');
  const { sql } = await import('drizzle-orm');
  const db = getDb();
  const rows = await db.execute(sql`SELECT id, guild_id, name, status, scheduled_start_at, synced_at FROM discord_events ORDER BY scheduled_start_at`);
  console.log('guild attendu :', process.env.DISCORD_GUILD_ID);
  console.log('lignes en base :', (rows.rows ?? rows).length);
  for (const r of (rows.rows ?? rows)) console.log(' ', r.id, r.guild_id, r.name, r.status, r.scheduled_start_at, r.synced_at);

  const bot = await vite.ssrLoadModule('/lib/discord-bot.ts');
  const events = await bot.getScheduledEvents();
  console.log('\nDiscord renvoie :', events.length);
  for (const e of events) console.log(' ', e.id, e.name, e.status, e.scheduled_start_time);
} finally { await vite.close(); }
