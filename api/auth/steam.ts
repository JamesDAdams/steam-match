import type { VercelRequest, VercelResponse } from '@vercel/node';
import { buildLoginUrl } from '../../lib/steam.ts';
import { COOKIE_NAME, parseCookies, readSession } from '../../lib/session.ts';

/**
 * GET /api/auth/steam
 * Relie un compte Steam au compte Discord déjà connecté.
 *
 * On EXIGE une session Discord : sinon n'importe qui pourrait relier un
 * SteamID et s'en attribuer la ludothèque.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const cookies = parseCookies(req.headers.cookie);
    const sess = await readSession(cookies[COOKIE_NAME]);

    if (!sess) {
      return res.redirect(
        302,
        `/?error=${encodeURIComponent(
          'Connecte-toi d’abord avec Discord, puis relie ton compte Steam.',
        )}`,
      );
    }

    return res.redirect(302, buildLoginUrl());
  } catch (err: any) {
    console.error('[auth/steam]', err);
    return res.redirect(302, `/?error=${encodeURIComponent(err.message)}`);
  }
}
