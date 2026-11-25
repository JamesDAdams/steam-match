import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * GET /api/ping — diagnostic de déploiement.
 *
 * Les imports sont DYNAMIQUES et chacun est encapsulé dans un try/catch :
 * si un module ne se résout pas sur Vercel, on en obtient le message exact
 * au lieu d'un `FUNCTION_INVOCATION_FAILED` opaque.
 *
 * Les secrets ne sont jamais renvoyés : uniquement des booléens.
 */
export default async function handler(_req: VercelRequest, res: VercelResponse) {
  const modules: Record<string, string> = {};

  // Chaque entrée = un import local, testé indépendamment.
  const probes: [string, () => Promise<unknown>][] = [
    ['db/index', () => import('../db/index')],
    ['db/schema', () => import('../db/schema')],
    ['lib/session', () => import('../lib/session')],
    ['lib/access', () => import('../lib/access')],
    ['lib/steam', () => import('../lib/steam')],
    ['lib/discord', () => import('../lib/discord')],
    ['@neondatabase/serverless', () => import('@neondatabase/serverless')],
    ['drizzle-orm/neon-http', () => import('drizzle-orm/neon-http')],
  ];

  for (const [name, load] of probes) {
    try {
      await load();
      modules[name] = 'ok';
    } catch (err: any) {
      modules[name] = `ECHEC: ${err?.code ?? ''} ${err?.message ?? err}`.slice(0, 300);
    }
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
    modules,
  });
}
