import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from '../db/index.ts';
import {
  users,
  ownedGames,
  gameCache,
  steamLinks,
  discordUsers,
  wishlistItems,
} from '../db/schema.ts';
import { sql, eq, inArray, and, gt } from 'drizzle-orm';
import { requireAccess } from '../lib/access.ts';

/**
 * GET /api/common?genres=Survie,Aventure&min=2&sort=players
 *
 * Jeux possédés par AU MOINS `min` membres du groupe, filtrables par genre.
 *
 * Note : les jeux non encore enrichis n'ont pas de genres. Ils sont renvoyés
 * avec genres=[] et ne matcheraient donc aucun filtre de genre — c'est voulu,
 * on préfère ne pas afficher n'importe quoi plutôt que de mentir sur le style.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const ctx = await requireAccess(req, res);
  if (!ctx) return;

  try {
    const db = getDb();

    // ── Mode wishlist ────────────────────────────────────────────────────
    // La wishlist est exposée ici plutôt que dans une fonction dédiée : le
    // plan Hobby de Vercel plafonne à 12 fonctions serverless.
    if (req.query.mode === 'wishlist') {
      return handleWishlist(req, res, db);
    }

    const genreFilter = parseList(req.query.genres as string | string[] | undefined);
    const tagFilter = parseList(req.query.tags as string | string[] | undefined);
    const minRaw = Number(req.query.min ?? 2);
    const minMembers = Number.isFinite(minRaw) ? Math.max(2, Math.min(50, minRaw)) : 2;
    const sort = (req.query.sort as string) ?? 'players';
    const requireEnriched = req.query.enriched === '1';

    // 1. appids détenus par >= minMembers personnes, avec la liste des possesseurs.
    const rows = await db.execute(sql`
      SELECT og.appid AS appid,
             count(DISTINCT og.steamid)::int AS owners,
             sum(og.playtime_forever)::int AS total_playtime,
             min(og.playtime_forever)::int AS min_playtime,
             array_agg(DISTINCT og.steamid) AS steamids
      FROM owned_games og
      GROUP BY og.appid
      HAVING count(DISTINCT og.steamid) >= ${minMembers}
    `);

    const appids = (rows.rows as any[]).map((r) => Number(r.appid));
    if (appids.length === 0) {
      return res.status(200).json({ ok: true, games: [], total: 0, genreCounts: {} });
    }

    // 2. Métadonnées.
    const metas = await db
      .select()
      .from(gameCache)
      .where(inArray(gameCache.appid, appids));

    const metaById = new Map(metas.map((m) => [m.appid, m]));

    // 3. Noms affichés : pseudo Discord en priorité, sinon pseudo Steam.
    //    On part de steam_links pour ne compter que les membres réellement
    //    membres du groupe (compte relié).
    const allUsers = await db
      .select({
        steamid: steamLinks.steamid,
        personaName: users.personaName,
        discordName: discordUsers.globalName,
        discordUsername: discordUsers.username,
      })
      .from(steamLinks)
      .innerJoin(users, eq(users.steamid, steamLinks.steamid))
      .leftJoin(discordUsers, eq(discordUsers.discordId, steamLinks.discordId));

    const nameById = new Map(
      allUsers.map((u) => [
        u.steamid,
        u.discordName || u.discordUsername || u.personaName,
      ]),
    );

    const memberCount = allUsers.length;

    // 4. Assemblage + filtres.
    let games = (rows.rows as any[]).map((r) => {
      const appid = Number(r.appid);
      const meta = metaById.get(appid);
      return {
        appid,
        name: meta?.name ?? `App ${appid}`,
        headerImage: meta?.headerImage ?? null,
        genres: meta?.genres ?? [],
        tags: meta?.tags ?? [],
        enriched: Boolean(meta?.enrichedAt),
        owners: Number(r.owners),
        totalPlaytime: Number(r.total_playtime ?? 0),
        minPlaytime: Number(r.min_playtime ?? 0),
        players: (r.steamids ?? []).map(
          (s: string) => nameById.get(s) ?? `Joueur ${s.slice(-4)}`,
        ),
      };
    });

    if (requireEnriched) games = games.filter((g) => g.enriched);

    if (genreFilter.length > 0) {
      const wanted = genreFilter.map(norm);
      games = games.filter((g) => g.genres.some((x) => wanted.includes(norm(x))));
    }
    if (tagFilter.length > 0) {
      const wanted = tagFilter.map(norm);
      games = games.filter((g) => g.tags.some((x) => wanted.includes(norm(x))));
    }

    // 5. Tri.
    if (sort === 'playtime') games.sort((a, b) => b.totalPlaytime - a.totalPlaytime);
    else if (sort === 'name') games.sort((a, b) => a.name.localeCompare(b.name, 'fr'));
    else games.sort((a, b) => b.owners - a.owners || b.totalPlaytime - a.totalPlaytime);

    // 6. Facettes : compte par genre, pour afficher les filtres disponibles.
    const genreCounts: Record<string, number> = {};
    for (const g of games) {
      for (const gen of g.genres) genreCounts[gen] = (genreCounts[gen] ?? 0) + 1;
    }

    return res.status(200).json({
      ok: true,
      games,
      total: games.length,
      memberCount,
      genreCounts,
      appliedFilters: { genres: genreFilter, tags: tagFilter, min: minMembers, sort },
    });
  } catch (err: any) {
    console.error('[common]', err);
    return res.status(500).json({ error: err.message });
  }
}

function parseList(v: string | string[] | undefined): string[] {
  if (!v) return [];
  const raw = Array.isArray(v) ? v.join(',') : v;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function norm(s: string) {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}


/**
 * GET /api/common?mode=wishlist
 *
 * Jeux souhaités par les membres du groupe, croisés avec ce que les autres
 * possèdent déjà.
 *
 * Deux usages concrets entre amis :
 *   - « on veut tous les trois ce jeu » → achat groupé qui fait consensus
 *   - « lui le veut, toi tu l'as déjà » → jouable tout de suite, zéro achat
 *
 * C'est le second cas qui a le plus de valeur, d'où le tri par nombre de
 * possesseurs en second critère.
 */
async function handleWishlist(req: VercelRequest, res: VercelResponse, db: any) {
  const minWishersRaw = Number(req.query.min ?? 1);
  const minWishers = Number.isFinite(minWishersRaw)
    ? Math.max(1, Math.min(50, minWishersRaw))
    : 1;
  const onlyPlayable = req.query.playable === '1';

  const rows = await db.execute(sql`
    SELECT w.appid AS appid,
           count(DISTINCT w.steamid)::int AS wish_count,
           array_agg(DISTINCT w.steamid) AS wishers
    FROM wishlist_items w
    GROUP BY w.appid
    HAVING count(DISTINCT w.steamid) >= ${minWishers}
  `);

  const appids = (rows.rows as any[]).map((r) => Number(r.appid));
  if (appids.length === 0) {
    return res.status(200).json({
      ok: true,
      mode: 'wishlist',
      games: [],
      total: 0,
      message:
        'Aucune wishlist synchronisée. Resynchronise : la wishlist doit aussi ' +
        'être publique dans les paramètres Steam.',
    });
  }

  // Métadonnées + possesseurs réels.
  const metas = await db
    .select()
    .from(gameCache)
    .where(inArray(gameCache.appid, appids));
  const metaById = new Map(metas.map((m: any) => [m.appid, m]));

  const ownedRows = await db.execute(sql`
    SELECT og.appid AS appid,
           array_agg(DISTINCT og.steamid) AS owners
    FROM owned_games og
    WHERE og.appid IN (${sql.join(
      appids.map((id) => sql`${id}`),
      sql`, `,
    )})
    GROUP BY og.appid
  `);
  const ownersByApp = new Map<number, string[]>();
  for (const r of ownedRows.rows as any[]) {
    ownersByApp.set(Number(r.appid), r.owners ?? []);
  }

  // Noms affichés.
  const people = await db
    .select({
      steamid: steamLinks.steamid,
      personaName: users.personaName,
      discordName: discordUsers.globalName,
      discordUsername: discordUsers.username,
    })
    .from(steamLinks)
    .innerJoin(users, eq(users.steamid, steamLinks.steamid))
    .leftJoin(discordUsers, eq(discordUsers.discordId, steamLinks.discordId));

  const nameById = new Map(
    people.map((p: any) => [
      p.steamid,
      p.discordName || p.discordUsername || p.personaName,
    ]),
  );
  const name = (sid: string) => nameById.get(sid) ?? `Joueur ${sid.slice(-4)}`;

  let games = (rows.rows as any[]).map((r) => {
    const appid = Number(r.appid);
    const meta = metaById.get(appid);
    const owners = ownersByApp.get(appid) ?? [];

    return {
      appid,
      name: meta?.name ?? `App ${appid}`,
      headerImage: meta?.headerImage ?? null,
      genres: meta?.genres ?? [],
      enriched: Boolean(meta?.enrichedAt),
      cheapestPrice: meta?.cheapestPrice ?? null,
      cheapestStore: meta?.cheapestStore ?? null,
      cheapestCurrency: meta?.cheapestCurrency ?? null,
      steamPrice: meta?.steamPrice ?? null,
      steamInitialPrice: meta?.steamInitialPrice ?? null,
      steamDiscount: meta?.steamDiscount ?? null,
      steamCurrency: meta?.steamCurrency ?? null,
      reviewScore: meta?.reviewScore ?? null,
      reviewPositive: meta?.reviewPositive ?? null,
      reviewNegative: meta?.reviewNegative ?? null,
      releaseDate: meta?.releaseDate ?? null,
      playModes: meta?.playModes ?? [],
      wishCount: Number(r.wish_count),
      wishers: (r.wishers ?? []).map(name),
      ownerCount: owners.length,
      owners: owners.map(name),
      playableNow: owners.length > 0,
    };
  });

  if (onlyPlayable) games = games.filter((g) => g.playableNow);

  games.sort(
    (a, b) => b.wishCount - a.wishCount || b.ownerCount - a.ownerCount,
  );

  return res.status(200).json({
    ok: true,
    mode: 'wishlist',
    games,
    total: games.length,
    memberCount: people.length,
    playableCount: games.filter((g) => g.playableNow).length,
  });
}
