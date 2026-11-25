/**
 * GET /api/ping — diagnostic de déploiement.
 *
 * Imports DYNAMIQUES, chacun dans un try/catch : si un module ne se résout
 * pas au runtime, on obtient le message exact au lieu d'un
 * `FUNCTION_INVOCATION_FAILED` opaque.
 *
 * Les secrets ne sont jamais renvoyés : uniquement des booléens.
 */
export default async function handler(_req: any, res: any) {
  const modules: Record<string, string> = {};

  const probes: [string, () => Promise<unknown>][] = [
    ['db/index', () => import('../db/index.ts')],
    ['db/schema', () => import('../db/schema.ts')],
    ['lib/session', () => import('../lib/session.ts')],
    ['lib/access', () => import('../lib/access.ts')],
    ['lib/steam', () => import('../lib/steam.ts')],
    ['lib/discord', () => import('../lib/discord.ts')],
    ['@neondatabase/serverless', () => import('@neondatabase/serverless')],
    ['drizzle-orm/neon-http', () => import('drizzle-orm/neon-http')],
  ];

  for (const [name, load] of probes) {
    try {
      await load();
      modules[name] = 'ok';
    } catch (err: any) {
      modules[name] = `ECHEC: ${err?.code ?? ''} ${err?.message ?? err}`.slice(0, 250);
    }
  }

  // Test réel de la base, indépendant des imports ci-dessus.
  let database = 'non testée';
  try {
    const { getDb } = await import('../db/index.ts');
    const { sql } = await import('drizzle-orm');
    await getDb().execute(sql`select 1`);
    database = 'ok';
  } catch (err: any) {
    database = `ECHEC: ${err?.message ?? err}`.slice(0, 250);
  }

  res.status(200).json({
    ok: true,
    runtime: { node: process.version },
    env: {
      DATABASE_URL: Boolean(process.env.DATABASE_URL),
      STEAM_API_KEY: Boolean(process.env.STEAM_API_KEY),
      SESSION_SECRET: Boolean(process.env.SESSION_SECRET),
      DISCORD_CLIENT_ID: Boolean(process.env.DISCORD_CLIENT_ID),
      DISCORD_CLIENT_SECRET: Boolean(process.env.DISCORD_CLIENT_SECRET),
      DISCORD_ADMIN_ID: Boolean(process.env.DISCORD_ADMIN_ID),
      BASE_URL: process.env.BASE_URL ?? null,
    },
    database,
    modules,
  });
}
