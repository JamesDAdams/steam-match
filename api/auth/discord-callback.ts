import type { VercelRequest, VercelResponse } from '@vercel/node';
import { exchangeCode } from '../../lib/discord.ts';
import {
  createSession,
  parseCookies,
  clearStateCookie,
} from '../../lib/session.ts';
import { upsertDiscordUser, resolveAccess } from '../../lib/access.ts';

/**
 * GET /api/auth/discord-callback
 *
 * Retour du consentement Discord. On vérifie le `state`, on échange le code
 * contre une identité, puis on n'accorde une session QUE si :
 *   - le compte est administrateur, ou
 *   - il est MEMBRE du serveur Discord (vérifié à chaque connexion), ou
 *   - il a été autorisé manuellement depuis la page admin (exception).
 *
 * L'appartenance au serveur est revérifiée ici en FORÇANT l'appel : c'est le
 * moment où l'on veut la réponse la plus fraîche. Le résultat est mémorisé
 * pour quelques minutes, ce qui évite d'interroger Discord à chaque requête.
 *
 * Si l'accès est refusé, on enregistre quand même le passage en base et on
 * redirige avec le discord_id en clair : c'est ce que la personne doit
 * communiquer à l'admin pour être ajoutée. Sans ça, l'admin n'aurait aucun
 * moyen simple de connaître l'ID.
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

    // 5. Décision d'accès, avec vérification fraîche de l'appartenance.
    const decision = await resolveAccess(profile.id, { forceMembership: true });

    // Le state a servi : on le supprime dans tous les cas.
    const cookiesOut = [clearStateCookie()];

    // 6. Accès refusé : pas de session, mais on affiche l'ID à transmettre.
    if (!decision.allowed) {
      const reason = decision.reason === 'NOT_MEMBER' ? 'not_member' : 'unverified';
      res.setHeader('Set-Cookie', cookiesOut);
      return res.redirect(
        302,
        `/?denied=1&reason=${reason}&id=${encodeURIComponent(
          profile.id,
        )}&name=${encodeURIComponent(profile.globalName || profile.username)}`,
      );
    }

    // 7. Session accordée.
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
