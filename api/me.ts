import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from '../db/index';
import { discordUsers, allowedDiscordIds, steamLinks, users } from '../db/schema';
import { eq } from 'drizzle-orm';
import {
  COOKIE_NAME,
  parseCookies,
  readSession,
  destroySession,
  clearCookie,
} from '../lib/session';
import { isAdminId } from '../lib/discord';

/**
 * GET  /api/me  → état complet de la session
 * POST /api/me  → déconnexion
 *
 * Le logout est fusionné ici volontairement : le plan Hobby de Vercel limite
 * un déploiement à 12 fonctions serverless. Chaque fichier de /api en consomme
 * une, donc on regroupe les routes de moindre importance.
 *
 * GET ne répond jamais 401/403 : le front doit distinguer « pas connecté »,
 * « connecté mais pas autorisé » et « connecté et autorisé ».
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const cookies = parseCookies(req.headers.cookie);

  // ── Déconnexion ──────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const raw = cookies[COOKIE_NAME];
    if (raw) {
      const token = raw.slice(0, raw.lastIndexOf('.'));
      await destroySession(token).catch(() => {});
    }
    res.setHeader('Set-Cookie', clearCookie());
    return res.status(200).json({ ok: true });
  }

  // ── État de la session ───────────────────────────────────────────────
  try {
    const sess = await readSession(cookies[COOKIE_NAME]);

    if (!sess) {
      return res.status(200).json({ ok: true, authenticated: false });
    }

    const db = getDb();
    const [du] = await db
      .select()
      .from(discordUsers)
      .where(eq(discordUsers.discordId, sess.discordId))
      .limit(1);

    if (!du) {
      return res.status(200).json({ ok: true, authenticated: false });
    }

    const admin = isAdminId(du.discordId);

    // Autorisation : admin (env) ou whitelist (DB).
    let allowed = admin;
    if (!allowed) {
      const [row] = await db
        .select({ id: allowedDiscordIds.discordId })
        .from(allowedDiscordIds)
        .where(eq(allowedDiscordIds.discordId, du.discordId))
        .limit(1);
      allowed = Boolean(row);
    }

    // Liaison Steam.
    let steam: null | {
      steamid: string;
      personaName: string;
      profileVisible: boolean;
      gamesVisible: boolean;
      lastSyncAt: Date | null;
    } = null;

    const [link] = await db
      .select()
      .from(steamLinks)
      .where(eq(steamLinks.discordId, du.discordId))
      .limit(1);

    if (link?.steamid) {
      const [u] = await db
        .select()
        .from(users)
        .where(eq(users.steamid, link.steamid))
        .limit(1);
      if (u) {
        steam = {
          steamid: u.steamid,
          personaName: u.personaName,
          profileVisible: u.profileVisible,
          gamesVisible: u.gamesVisible,
          lastSyncAt: u.lastSyncAt,
        };
      }
    }

    return res.status(200).json({
      ok: true,
      authenticated: true,
      allowed,
      isAdmin: admin,
      discord: {
        id: du.discordId,
        username: du.username,
        globalName: du.globalName,
        avatarUrl: du.avatarUrl,
      },
      steam,
    });
  } catch (err: any) {
    console.error('[me]', err);
    return res.status(500).json({ error: err.message });
  }
}
