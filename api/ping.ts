import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * GET /api/ping — diagnostic de déploiement.
 *
 * N'importe AUCUN module local : si cette route répond, le runtime et les
 * variables d'environnement fonctionnent, et le problème vient des imports
 * du reste de l'application. Si elle échoue aussi, c'est la configuration
 * du projet (variables, runtime) qu'il faut regarder.
 *
 * Les secrets ne sont jamais renvoyés : uniquement des booléens.
 */
export default function handler(_req: VercelRequest, res: VercelResponse) {
  res.status(200).json({
    ok: true,
    runtime: {
      node: process.version,
      hasProcessEnv: typeof process.env === 'object',
    },
    env: {
      DATABASE_URL: Boolean(process.env.DATABASE_URL),
      STEAM_API_KEY: Boolean(process.env.STEAM_API_KEY),
      SESSION_SECRET: Boolean(process.env.SESSION_SECRET),
      DISCORD_CLIENT_ID: Boolean(process.env.DISCORD_CLIENT_ID),
      DISCORD_CLIENT_SECRET: Boolean(process.env.DISCORD_CLIENT_SECRET),
      DISCORD_ADMIN_ID: Boolean(process.env.DISCORD_ADMIN_ID),
      BASE_URL: process.env.BASE_URL ?? null,
    },
  });
}
