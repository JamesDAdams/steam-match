import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from '../db/index.ts';
import { users, gameCache, steamLinks, discordUsers } from '../db/schema.ts';
import { sql, eq } from 'drizzle-orm';
import { requireAccess } from '../lib/access.ts';

/**
 * GET /api/group
 * Membres du groupe (ceux qui ont relié un compte Steam) + état de synchro.
 *
 * On part de steam_links, pas de users : un compte Steam sans lien Discord
 * (lien rompu) ne fait plus partie du groupe.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const ctx = await requireAccess(req, res);
  if (!ctx) return;

  try {
    const db = getDb();

    const members = await db
      .select({
        discordId: steamLinks.discordId,
        discordName: discordUsers.globalName,
        discordUsername: discordUsers.username,
        discordAvatar: discordUsers.avatarUrl,
        steamid: users.steamid,
        personaName: users.personaName,
        steamAvatar: users.avatarUrl,
        profileVisible: users.profileVisible,
        gamesVisible: users.gamesVisible,
        lastSyncAt: users.lastSyncAt,
        lastSyncError: users.lastSyncError,
      })
      .from(steamLinks)
      .innerJoin(users, eq(users.steamid, steamLinks.steamid))
      .leftJoin(discordUsers, eq(discordUsers.discordId, steamLinks.discordId))
      .orderBy(steamLinks.linkedAt);

    const [counts] = await db
      .select({
        total: sql<number>`count(*)::int`,
        enriched: sql<number>`count(*) filter (where ${gameCache.enrichedAt} is not null)::int`,
      })
      .from(gameCache);

    return res.status(200).json({
      ok: true,
      members: members.map((m) => ({
        ...m,
        // Nom affiché : pseudo Discord si dispo, sinon pseudo Steam.
        displayName: m.discordName || m.discordUsername || m.personaName,
      })),
      cache: {
        total: counts?.total ?? 0,
        enriched: counts?.enriched ?? 0,
        pending: (counts?.total ?? 0) - (counts?.enriched ?? 0),
      },
    });
  } catch (err: any) {
    console.error('[group]', err);
    return res.status(500).json({ error: err.message });
  }
}
