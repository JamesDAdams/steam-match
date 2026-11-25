import fs from 'node:fs';
if (fs.existsSync('.env.local')) process.loadEnvFile('.env.local');
import { createServer } from 'vite';
const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
const BASE = 'https://le-bastion-des-gamers.netlify.app';
let token;
try {
  const session = await vite.ssrLoadModule('/lib/session.ts');
  const created = await session.createSession(process.env.DISCORD_ADMIN_ID);
  token = created.token;
  const cookie = `sm_session=${created.cookie.split(';')[0].split('=')[1]}`;

  const t0 = Date.now();
  const r = await fetch(`${BASE}/api/events`, { headers: { cookie } });
  const txt = await r.text();
  console.log(`GET /api/events -> HTTP ${r.status} en ${Date.now() - t0} ms`);
  try {
    const j = JSON.parse(txt);
    console.log('total:', j.total, '| upcoming:', j.upcoming?.length, '| past:', j.past?.length);
    for (const e of [...(j.upcoming ?? []), ...(j.past ?? [])]) {
      console.log('  -', e.id, e.name, '| startAt', e.startAt, '| isPast', e.isPast);
    }
    console.log('lastSyncAt:', j.lastSyncAt);
  } catch { console.log(txt.slice(0, 400)); }
} finally {
  try {
    const { getDb } = await vite.ssrLoadModule('/db/index.ts');
    const { sessions } = await vite.ssrLoadModule('/db/schema.ts');
    const { eq } = await import('drizzle-orm');
    await getDb().delete(sessions).where(eq(sessions.token, token));
    console.log('session de test supprimée');
  } catch (e) { console.log('nettoyage:', e.message); }
  await vite.close();
}
