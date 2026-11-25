import type { VercelRequest, VercelResponse } from '@vercel/node';
import { verifyOpenIdResponse, getPlayerSummaries } from '../../lib/steam';
import { COOKIE_NAME, parseCookies, readSession } from '../../lib/session';
import { getDb } from '../../db/index';
import { users, steamLinks } from '../../db/schema';
import { eq } from 'drizzle-orm';

/**
 * GET /api/auth/callback
 * Retour d'OpenID Steam : relie le SteamID vérifié au compte Discord connecté.
 *
 * SÉCURITÉ : verifyOpenIdResponse() refait un aller-retour check_authentication
 * auprès de Steam. Le claimed_id de la query vient du client et serait sinon
 * trivialement forgeable.
 *
 * Un SteamID ne peut être relié qu'à un seul compte Discord (contrainte UNIQUE
 * sur steam_links.steamid), sinon deux personnes partageraient la même
 * ludothèque.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const q: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.query ?? {})) {
    if (typeof v === 'string') q[k] = v;
  }

  try {
    // 1. Session Discord obligatoire.
    const cookies = parseCookies(req.headers.cookie);
    const sess = await readSession(cookies[COOKIE_NAME]);
    if (!sess) {
      return res.redirect(
        302,
        `/?error=${encodeURIComponent('Session Discord expirée. Reconnecte-toi.')}`,
      );
    }

    // 2. Vérification OpenID.
    const steamid = await verifyOpenIdResponse(q);
    if (!steamid) {
      return res.redirect(
        302,
        `/?error=${encodeURIComponent('Authentification Steam invalide ou usurpée.')}`,
      );
    }

    const db = getDb();

    // 3. Ce SteamID est-il déjà relié à quelqu'un d'autre ?
    const [existing] = await db
      .select()
      .from(steamLinks)
      .where(eq(steamLinks.steamid, steamid))
      .limit(1);

    if (existing && existing.discordId !== sess.discordId) {
      return res.redirect(
        302,
        `/?error=${encodeURIComponent(
          'Ce compte Steam est déjà relié à un autre compte Discord.',
        )}`,
      );
    }

    // 4. Profil Steam.
    const summaries = await getPlayerSummaries([steamid]);
    const profile = summaries.get(steamid);
    const personaName = profile?.personaName ?? `Joueur ${steamid.slice(-4)}`;
    const profileVisible = (profile?.visibility ?? 1) === 3;

    await db
      .insert(users)
      .values({
        steamid,
        personaName,
        avatarUrl: profile?.avatarUrl ?? null,
        profileUrl: profile?.profileUrl ?? null,
        profileVisible,
      })
      .onConflictDoUpdate({
        target: users.steamid,
        set: {
          personaName,
          avatarUrl: profile?.avatarUrl ?? null,
          profileUrl: profile?.profileUrl ?? null,
          profileVisible,
        },
      });

    // 5. Liaison Discord ↔ Steam.
    await db
      .insert(steamLinks)
      .values({ discordId: sess.discordId, steamid })
      .onConflictDoUpdate({
        target: steamLinks.discordId,
        set: { steamid, linkedAt: new Date() },
      });

    return res.redirect(302, '/commun?linked=1');
  } catch (err: any) {
    console.error('[auth/callback]', err);
    return res.redirect(302, `/?error=${encodeURIComponent(err.message)}`);
  }
}
