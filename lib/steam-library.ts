import { getDb } from '../db/index.ts';
import { users, ownedGames, gameCache, enrichQueue } from '../db/schema.ts';
import { and, eq, sql } from 'drizzle-orm';
import { getOwnedGames, getPlayerSummaries } from './steam.ts';

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
): Promise<{ count: number }> {
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
          playtimeForever: g.playtime_forever ?? 0,
          playtime2Weeks: g.playtime_2weeks ?? 0,
          source: kind,
          sourceSteamid: linkSteamid,
          updatedAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: [ownedGames.steamid, ownedGames.appid],
        set: {
          // Un jeu réellement possédé le reste : on ne le dégrade pas.
          source: sql`CASE WHEN owned_games.source = 'owned' THEN 'owned' ELSE excluded.source END`,
          sourceSteamid: sql`CASE WHEN owned_games.source = 'owned' THEN NULL ELSE excluded.source_steamid END`,
          updatedAt: now,
        },
      });
  }

  await seedCacheAndQueue(valid.map((g) => ({ appid: g.appid, name: g.name })));

  return { count: valid.length };
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
