import { getDb } from '../db/index.ts';
import { users, ownedGames, gameCache, enrichQueue, wishlistItems } from '../db/schema.ts';
import { and, eq, sql } from 'drizzle-orm';
import { getOwnedGames, getPlayerSummaries, getWishlist } from './steam.ts';

/**
 * Synchronisation des ludothèques Steam, partagée par trois appelants :
 *   - POST /api/sync (bouton « Synchroniser » du profil) ;
 *   - POST /api/steam-accounts (ajout ou resynchronisation d'un compte lié) ;
 *   - la tâche planifiée horaire, qui rafraîchit tous les comptes.
 *
 * Centraliser évite que ces trois chemins divergent : c'est exactement le genre
 * d'écart qui produit des jeux manquants ou, à l'inverse, comptés deux fois.
 */

/** Taille des lots d'écriture : une requête par jeu expirerait la fonction. */
const BATCH = 200;

export type GameSource = 'owned' | 'secondary' | 'family';

export interface LibrarySyncResult {
  gamesCount: number;
  gamesVisible: boolean;
  profileVisible: boolean;
  /** true si Steam n'a rien renvoyé (profil privé, le plus souvent). */
  empty: boolean;
}

/**
 * Synchronise le compte PRINCIPAL d'un membre.
 *
 * GetOwnedGames ne renvoie que les jeux réellement achetés : les jeux déjà
 * marqués « secondaire » ou « famille » ne sont donc jamais touchés par la
 * purge (`source = 'owned'`), sinon ils disparaîtraient à chaque passage.
 */
export async function syncOwnedLibrary(
  steamid: string,
  opts: { withWishlist?: boolean } = {},
): Promise<LibrarySyncResult> {
  const db = getDb();

  const summaries = await getPlayerSummaries([steamid]);
  const profile = summaries.get(steamid);
  const profileVisible = (profile?.visibility ?? 1) === 3;

  const { games, gamesVisible } = await getOwnedGames(steamid);
  const now = new Date();

  if (games.length === 0) {
    await db
      .update(users)
      .set({
        profileVisible,
        gamesVisible: false,
        lastSyncAt: now,
        lastSyncError:
          'Aucun jeu renvoyé. Le profil est probablement privé — passe-le en public.',
      })
      .where(eq(users.steamid, steamid));

    return { gamesCount: 0, gamesVisible: false, profileVisible, empty: true };
  }

  const valid = games.filter((g) => Number.isInteger(g.appid) && g.appid > 0);

  for (let i = 0; i < valid.length; i += BATCH) {
    const slice = valid.slice(i, i + BATCH);
    await db
      .insert(ownedGames)
      .values(
        slice.map((g) => ({
          steamid,
          appid: g.appid,
          playtimeForever: g.playtime_forever ?? 0,
          playtime2Weeks: g.playtime_2weeks ?? 0,
          source: 'owned' as const,
          sourceSteamid: null,
          updatedAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: [ownedGames.steamid, ownedGames.appid],
        set: {
          playtimeForever: sql`excluded.playtime_forever`,
          playtime2Weeks: sql`excluded.playtime_2weeks`,
          // Le jeu est désormais réellement possédé : il n'est plus
          // « secondaire » ni « famille », et n'est plus rattaché à un compte lié.
          source: sql`'owned'`,
          sourceSteamid: sql`NULL`,
          updatedAt: now,
        },
      });
  }

  // Jeux revendus / masqués : on ne supprime QUE ceux du compte principal.
  const currentIds = valid.map((g) => g.appid);
  if (currentIds.length > 0) {
    await db.execute(sql`
      DELETE FROM owned_games
      WHERE steamid = ${steamid}
        AND source = 'owned'
        AND appid NOT IN (${sql.join(
          currentIds.map((id) => sql`${id}`),
          sql`, `,
        )})
    `);
  }

  await seedCacheAndQueue(valid.map((g) => ({ appid: g.appid, name: g.name })));

  await db
    .update(users)
    .set({ profileVisible, gamesVisible, lastSyncAt: now, lastSyncError: null })
    .where(eq(users.steamid, steamid));

  return {
    gamesCount: valid.length,
    gamesVisible,
    profileVisible,
    empty: false,
  };
}

/**
 * Aspire la ludothèque d'un compte lié (secondaire ou famille) sous le compte
 * du membre, en conservant l'origine de chaque jeu.
 *
 * Les jeux déjà possédés par le compte principal gardent leur étiquette : un
 * jeu n'est jamais compté deux fois, la clé (steamid, appid) l'interdit.
 */
export async function absorbLibrary(
  ownerSteamid: string,
  linkSteamid: string,
  kind: Exclude<GameSource, 'owned'>,
): Promise<{ count: number; wishlistCount: number }> {
  const db = getDb();
  const { games, gamesVisible } = await getOwnedGames(linkSteamid);

  if (!gamesVisible) {
    throw new Error(
      'Ce profil Steam est privé : rends la liste de jeux publique (Profil → ' +
        'Modifier le profil → Confidentialité) pour pouvoir l’importer.',
    );
  }

  const now = new Date();

  // On remplace uniquement les jeux venus de CE compte : ceux du compte
  // principal ou d'un autre compte lié restent intacts.
  await db
    .delete(ownedGames)
    .where(
      and(eq(ownedGames.steamid, ownerSteamid), eq(ownedGames.sourceSteamid, linkSteamid)),
    );

  const valid = games.filter((g) => Number.isInteger(g.appid) && g.appid > 0);

  for (let i = 0; i < valid.length; i += BATCH) {
    const slice = valid.slice(i, i + BATCH);
    await db
      .insert(ownedGames)
      .values(
        slice.map((g) => ({
          steamid: ownerSteamid,
          appid: g.appid,
          // Le temps de jeu d'un compte FAMILLE appartient à quelqu'un d'autre :
          // le reprendre gonflerait les statistiques du membre (heures jouées,
          // « joués récemment », styles de jeu). On ne garde que les jeux.
          playtimeForever: kind === 'family' ? 0 : (g.playtime_forever ?? 0),
          playtime2Weeks: kind === 'family' ? 0 : (g.playtime_2weeks ?? 0),
          source: kind,
          sourceSteamid: linkSteamid,
          updatedAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: [ownedGames.steamid, ownedGames.appid],
        set: {
          // IMPORTANT : un jeu possédé garde SON temps de jeu. Sans ce CASE,
          // l'import d'un compte famille écrasait les heures du compte
          // principal avec 0 (Dead by Daylight : 2273 h → 0 h).
          playtimeForever: sql`CASE WHEN owned_games.source = 'owned' THEN owned_games.playtime_forever ELSE excluded.playtime_forever END`,
          playtime2Weeks: sql`CASE WHEN owned_games.source = 'owned' THEN owned_games.playtime_2weeks ELSE excluded.playtime_2weeks END`,
          // Un jeu réellement possédé le reste : on ne le dégrade pas.
          source: sql`CASE WHEN owned_games.source = 'owned' THEN 'owned' ELSE excluded.source END`,
          sourceSteamid: sql`CASE WHEN owned_games.source = 'owned' THEN NULL ELSE excluded.source_steamid END`,
          updatedAt: now,
        },
      });
  }

  await seedCacheAndQueue(valid.map((g) => ({ appid: g.appid, name: g.name })));

  // Wishlist : uniquement celle d'un compte SECONDAIRE. Celle d'un compte
  // famille appartient à un autre joueur — l'agréger fausserait les envies du
  // membre.
  let wishlistCount = 0;
  if (kind === 'secondary') {
    wishlistCount = await syncLinkedWishlist(ownerSteamid, linkSteamid);
  }

  return { count: valid.length, wishlistCount };
}

/**
 * Importe la wishlist d'un compte secondaire sous le membre.
 *
 * La suppression est bornée à `source_steamid` pour ne pas effacer les souhaits
 * du compte principal, qui vivent dans la même table.
 */
async function syncLinkedWishlist(
  ownerSteamid: string,
  linkSteamid: string,
): Promise<number> {
  const db = getDb();
  const wishlist = await getWishlist(linkSteamid);
  if (!wishlist.wishlistVisible || wishlist.items.length === 0) {
    // Wishlist retirée côté Steam : on nettoie ce que ce compte avait apporté.
    await db
      .delete(wishlistItems)
      .where(
        and(
          eq(wishlistItems.steamid, ownerSteamid),
          eq(wishlistItems.sourceSteamid, linkSteamid),
        ),
      );
    return 0;
  }

  const now = new Date();

  for (let i = 0; i < wishlist.items.length; i += BATCH) {
    const slice = wishlist.items.slice(i, i + BATCH);
    await db
      .insert(wishlistItems)
      .values(
        slice.map((w) => ({
          steamid: ownerSteamid,
          appid: w.appid,
          priority: w.priority,
          sourceSteamid: linkSteamid,
          updatedAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: [wishlistItems.steamid, wishlistItems.appid],
        set: {
          priority: sql`excluded.priority`,
          sourceSteamid: sql`COALESCE(wishlist_items.source_steamid, excluded.source_steamid)`,
          updatedAt: now,
        },
      });
  }

  // Chaque souhait doit avoir une ligne de cache, sinon l'interface affiche
  // « App 12345 » et le worker d'enrichissement ne peut jamais le traiter
  // (il travaille sur game_cache, pas sur wishlist_items). C'est l'oubli qui
  // a laissé 148 souhaits bloqués en « identification ».
  await seedWishlistCache(wishlist.items.map((w) => w.appid));

  await db.execute(sql`
    DELETE FROM wishlist_items
    WHERE steamid = ${ownerSteamid}
      AND source_steamid = ${linkSteamid}
      AND appid NOT IN (${sql.join(
        wishlist.items.map((w) => sql`${w.appid}`),
        sql`, `,
      )})
  `);

  return wishlist.items.length;
}

/**
 * Crée les lignes de cache manquantes pour des jeux souhaités, avec un nom
 * provisoire, et les met en file d'enrichissement.
 */
export async function seedWishlistCache(appids: number[]): Promise<void> {
  if (appids.length === 0) return;
  const db = getDb();

  for (let i = 0; i < appids.length; i += BATCH) {
    const slice = appids.slice(i, i + BATCH);
    await db
      .insert(gameCache)
      .values(slice.map((appid) => ({ appid, name: `App ${appid}` })))
      .onConflictDoNothing();
    await db
      .insert(enrichQueue)
      .values(slice.map((appid) => ({ appid, priority: 2 })))
      .onConflictDoNothing();
  }
}

/** Remplit le cache de noms et met les jeux inconnus en file d'enrichissement. */
async function seedCacheAndQueue(apps: { appid: number; name?: string }[]) {
  const db = getDb();
  const named = apps.filter((a) => Boolean(a.name));

  for (let i = 0; i < named.length; i += BATCH) {
    const slice = named.slice(i, i + BATCH);
    await db
      .insert(gameCache)
      .values(slice.map((a) => ({ appid: a.appid, name: a.name as string })))
      .onConflictDoNothing();
  }

  for (let i = 0; i < apps.length; i += BATCH) {
    const slice = apps.slice(i, i + BATCH);
    await db
      .insert(enrichQueue)
      .values(slice.map((a) => ({ appid: a.appid, priority: 1 })))
      .onConflictDoNothing();
  }
}
