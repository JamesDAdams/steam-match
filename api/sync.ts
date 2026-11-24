import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from '../db/index.ts';
import { users, ownedGames, gameCache, enrichQueue } from '../db/schema.ts';
import { eq, sql } from 'drizzle-orm';
import { requireSteam } from './lib/access.ts';
import { getOwnedGames, getPlayerSummaries } from './lib/steam.ts';

/**
 * POST /api/sync
 * Récupère la ludothèque de l'utilisateur connecté + les temps de jeu.
 *
 * PRÉREQUIS CÔTÉ STEAM (impossible à contourner) :
 *   - profil en PUBLIC → sinon aucune ludothèque renvoyée
 *   - « Détails du jeu » en public → sinon ludothèque renvoyée mais
 *     playtime_forever = 0 partout, donc recommandations impossibles.
 * Ajouter la personne à un groupe Steam ne change rien : l'API est anonyme.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const ctx = await requireSteam(req, res);
  if (!ctx) return;
  const steamid = ctx.steamid;

  try {
    const db = getDb();

    // Profil à jour (visibilité + pseudo).
    const summaries = await getPlayerSummaries([steamid]);
    const profile = summaries.get(steamid);
    const profileVisible = (profile?.visibility ?? 1) === 3;

    const { games, gamesVisible } = await getOwnedGames(steamid);

    if (games.length === 0) {
      await db
        .update(users)
        .set({
          profileVisible,
          gamesVisible: false,
          lastSyncAt: new Date(),
          lastSyncError:
            'Aucun jeu renvoyé. Le profil est probablement privé — passe-le en public.',
        })
        .where(eq(users.steamid, steamid));

      return res.status(200).json({
        ok: false,
        gamesCount: 0,
        message:
          'Ludothèque inaccessible. Passe ton profil Steam en public ' +
          '(Modifier le profil > Paramètres de confidentialité > Public), ' +
          'puis réessaie.',
        profileVisible,
        needsPublicProfile: true,
      });
    }

    // 1. Upsert des jeux possédés.
    const now = new Date();
    await db
      .insert(ownedGames)
      .values(
        games.map((g) => ({
          steamid,
          appid: g.appid,
          playtimeForever: g.playtime_forever ?? 0,
          playtime2Weeks: g.playtime_2weeks ?? 0,
          updatedAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: [ownedGames.steamid, ownedGames.appid],
        set: {
          playtimeForever: sql`excluded.playtime_forever`,
          playtime2Weeks: sql`excluded.playtime_2weeks`,
          updatedAt: now,
        },
      });

    // 2. Supprime les jeux qui ne sont plus possédés (revendus/masqués).
    const currentIds = games.map((g) => g.appid);
    if (currentIds.length > 0) {
      await db.execute(sql`
        DELETE FROM owned_games
        WHERE steamid = ${steamid}
          AND appid NOT IN (${sql.join(
            currentIds.map((id) => sql`${id}`),
            sql`, `,
          )})
      `);
    }

    // 3. Métadonnées de base (nom + icône) depuis GetOwnedGames.
    //    Les genres viendront plus tard via /api/enrich.
    for (const g of games) {
      if (!g.name) continue;
      await db
        .insert(gameCache)
        .values({ appid: g.appid, name: g.name })
        .onConflictDoNothing();
    }

    // 4. Met en file les appids jamais enrichis.
    await db
      .insert(enrichQueue)
      .values(games.map((g) => ({ appid: g.appid, priority: 1 })))
      .onConflictDoNothing();

    await db
      .update(users)
      .set({
        profileVisible,
        gamesVisible,
        lastSyncAt: now,
        lastSyncError: null,
      })
      .where(eq(users.steamid, steamid));

    const playedCount = games.filter((g) => (g.playtime_forever ?? 0) > 0).length;

    return res.status(200).json({
      ok: true,
      gamesCount: games.length,
      playedCount,
      gamesVisible,
      profileVisible,
      warning: !gamesVisible
        ? 'Aucun temps de jeu renvoyé. Active « Toujours afficher les détails du jeu » ' +
          'dans les paramètres de confidentialité Steam, sinon les recommandations ' +
          'ne pourront pas fonctionner.'
        : null,
    });
  } catch (err: any) {
    console.error('[sync]', err);
    const db = getDb();
    await db
      .update(users)
      .set({ lastSyncError: err.message })
      .where(eq(users.steamid, steamid))
      .catch(() => {});

    return res.status(500).json({ error: err.message });
  }
}
