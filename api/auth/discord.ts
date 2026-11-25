import type { VercelRequest, VercelResponse } from '@vercel/node';
import { randomBytes } from 'node:crypto';
import { buildAuthorizeUrl } from '../../lib/discord';
import { buildStateCookie } from '../../lib/session';

/**
 * GET /api/auth/discord
 * Démarre le flux OAuth2 Discord.
 *
 * On génère un `state` aléatoire, stocké dans un cookie httpOnly à courte
 * durée : sans lui, un attaquant pourrait forcer une victime à se connecter
 * sur son propre compte (login CSRF).
 */
export default function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const state = randomBytes(16).toString('hex');
    res.setHeader('Set-Cookie', buildStateCookie(state));
    res.redirect(302, buildAuthorizeUrl(state));
  } catch (err: any) {
    console.error('[auth/discord]', err);
    res.redirect(302, `/?error=${encodeURIComponent(err.message)}`);
  }
}
