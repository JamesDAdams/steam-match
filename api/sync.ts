import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from '../db/index.ts';
import { users, gameCache, enrichQueue, wishlistItems } from '../db/schema.ts';
import { eq, sql } from 'drizzle-orm';
import { requireSteam } from '../lib/access.ts';
import { getWishlist } from '../lib/steam.ts';
import { syncOwnedLibrary } from '../lib/steam-library.ts';

/**
 * POST /api/sync
 * Récupère la ludothèque de l'utilisateur connecté + les temps de jeu.
 *
 * PRÉREQUIS CÔTÉ STEAM (impossible à contourner) :
 *   - profil en PUBLIC → sinon aucune ludothèque renvoyée
 *   - « Détails du jeu » en public → sinon ludothèque renvoyée mais
 *     playtime_forever = 0 partout, donc recommandations impossibles.
 * Ajouter la personne à un groupe Steam ne change rien : l'API est anonyme.
 *
 * La partie ludothèque vit dans lib/steam-library.ts : la tâche planifiée et
 * l'ajout d'un compte lié utilisent exactement le même code.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const ctx = await requireSteam(req, res);
  if (!ctx) return;
  const steamid = ctx.steamid;

  try {
    const db = getDb();

    const result = await syncOwnedLibrary(steamid);

    if (result.empty) {
      return res.status(200).json({
        ok: false,
        gamesCount: 0,
        message:
          'Ludothèque inaccessible. Passe ton profil Steam en public ' +
          '(Modifier le profil > Paramètres de confidentialité > Public), ' +
          'puis réessaie.',
        profileVisible: result.profileVisible,
        needsPublicProfile: true,
      });
    }

    const { gamesCount, gamesVisible, profileVisible } = result;
    const now = new Date();

    // 5. Wishlist : souhaitée, mais pas encore achetée.
    //    Servira à croiser les envies du groupe avec ce que les autres possèdent.
    const wishlist = await getWishlist(steamid);
    if (wishlist.items.length > 0) {
      await db
        .insert(wishlistItems)
        .values(
          wishlist.items.map((w) => ({
            steamid,
            appid: w.appid,
            priority: w.priority,
            updatedAt: now,
          })),
        )
        .onConflictDoUpdate({
          target: [wishlistItems.steamid, wishlistItems.appid],
          set: { priority: sql`excluded.priority`, updatedAt: now },
        });

      // Retire les jeux sortis de la wishlist.
      await db.execute(sql`
        DELETE FROM wishlist_items
        WHERE steamid = ${steamid}
          AND appid NOT IN (${sql.join(
            wishlist.items.map((w) => sql`${w.appid}`),
            sql`, `,
          )})
      `);

      // Les jeux souhaités méritent aussi des métadonnées (nom, image, genres,
      // prix). Il FAUT une ligne game_cache : le worker d'enrichissement fait
      // une jointure enrich_queue ↔ game_cache, donc sans elle le jeu serait
      // en file mais jamais traité.
      // Le nom provisoire « App <id> » est écrasé à l'enrichissement.
      await db
        .insert(gameCache)
        .values(
          wishlist.items.map((w) => ({
            appid: w.appid,
            name: `App ${w.appid}`,
          })),
        )
        .onConflictDoNothing();

      await db
        .insert(enrichQueue)
        .values(wishlist.items.map((w) => ({ appid: w.appid, priority: 2 })))
        .onConflictDoNothing();
    }

    return res.status(200).json({
      ok: true,
      gamesCount,
      wishlistCount: wishlist.items.length,
      wishlistVisible: wishlist.wishlistVisible,
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
