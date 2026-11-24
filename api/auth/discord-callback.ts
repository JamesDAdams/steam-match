import type { VercelRequest, VercelResponse } from '@vercel/node';
import { exchangeCode, isAdminId } from '../../lib/discord.ts';
import {
  COOKIE_NAME,
  createSession,
  parseCookies,
  buildStateCookie,
  clearStateCookie,
} from '../../lib/session.ts';
import { upsertDiscordUser, isAllowed } from '../../lib/access.ts';
import { getDb } from '../../db/index.ts';
import { discordUsers } from '../../db/schema.ts';
import { eq } from 'drizzle-orm';

/**
 * GET /api/auth/discord-callback
 *
 * Retour du consentement Discord. On vérifie le `state`, on échange le code
 * contre une identité, puis on n'accorde une session QUE si le compte est
 * autorisé (whitelist ou admin défini dans l'env).
 *
 * Si le compte n'est pas autorisé, on enregistre quand même son passage en
 * base et on redirige avec son discord_id en clair : c'est ce que la personne
 * doit communiquer à l'admin pour être ajoutée. Sans ça, l'admin n'aurait
 * aucun moyen simple de connaître l'ID.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const q = req.query as Record<string, string>;

  try {
    const cookies = parseCookies(req.headers.cookie);

    // 1. Erreur renvoyée par Discord (l'utilisateur a refusé, par exemple).
    if (q.error) {
      return res.redirect(302, `/?error=${encodeURIComponent('Connexion Discord annulée.')}`);
    }

    // 2. Contrôle anti-CSRF.
    const expectedState = cookies['sm_oauth_state'];
    if (!q.state || !expectedState || q.state !== expectedState) {
      return res.redirect(
        302,
        `/?error=${encodeURIComponent(
          'Session OAuth invalide ou expirée. Ressaie depuis le début.',
        )}`,
      );
    }

    if (!q.code) {
      return res.redirect(302, `/?error=${encodeURIComponent('Code Discord manquant.')}`);
    }

    // 3. Identité Discord.
    const profile = await exchangeCode(q.code);

    // 4. Trace en base (utile à l'admin même si l'accès est refusé).
    await upsertDiscordUser(profile);

    const db = getDb();
    const [du] = await db
      .select()
      .from(discordUsers)
      .where(eq(discordUsers.discordId, profile.id))
      .limit(1);

    const admin = isAdminId(profile.id);
    const allowed = admin || (await isAllowed(profile.id));

    // Le state a servi : on le supprime dans tous les cas.
    const cookiesOut = [clearStateCookie()];

    // 5. Accès refusé : pas de session, mais on affiche l'ID à transmettre.
    if (!allowed) {
      res.setHeader('Set-Cookie', cookiesOut);
      return res.redirect(
        302,
        `/?denied=1&id=${encodeURIComponent(profile.id)}&name=${encodeURIComponent(
          du?.globalName || profile.username,
        )}`,
      );
    }

    // 6. Session accordée.
    const { cookie } = await createSession(profile.id);
    cookiesOut.push(cookie);
    res.setHeader('Set-Cookie', cookiesOut);

    // On atterrit sur l'accueil : il guide les étapes restantes
    // (relier Steam, synchroniser) et /commun serait vide sans Steam.
    return res.redirect(302, '/');
  } catch (err: any) {
    console.error('[auth/discord-callback]', err);
    return res.redirect(302, `/?error=${encodeURIComponent(err.message)}`);
  }
}
