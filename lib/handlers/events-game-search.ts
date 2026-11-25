import { getDb } from '../../db/index.ts';
import { gameCache } from '../../db/schema.ts';
import { sql } from 'drizzle-orm';
import { requireAdmin } from '../access.ts';

/**
 * GET /api/events/game-search?q=valheim
 *
 * Recherche un jeu dans la bibliothèque partagée pour préremplir un événement :
 * description, jaquette et prix (Steam + meilleure clé).
 *
 * POURQUOI LA BIBLIOTHÈQUE ET PAS TOUT LE CATALOGUE STEAM : ces jeux sont déjà
 * enrichis (jaquette, description, prix Steam et prix en clé), donc la
 * sélection remplit le formulaire instantanément. Chercher dans tout Steam
 * obligerait à appeler l'API du Store à chaque frappe, pour un jeu que le
 * serveur ne possède peut-être même pas.
 *
 * Réservé à l'admin : c'est lui qui crée les événements.
 */
export default async function handler(req: any, res: any) {
  if ((req.method || 'GET').toUpperCase() !== 'GET') {
    return res.status(405).json({ error: `Méthode ${req.method} non supportée.` });
  }

  const ctx = await requireAdmin(req, res);
  if (!ctx) return;

  const raw = String(req.query?.q ?? '').trim();
  if (raw.length < 2) {
    return res.status(200).json({ ok: true, games: [] });
  }

  // Les jokers SQL saisis par l'utilisateur sont neutralisés : « 100% » doit
  // chercher le texte « 100% », pas « tout ».
  const escaped = raw.replace(/[\\%_]/g, (m) => `\\${m}`);
  const contains = `%${escaped}%`;
  const startsWith = `${escaped}%`;

  try {
    const db = getDb();

    const rows = await db
      .select({
        appid: gameCache.appid,
        name: gameCache.name,
        headerImage: gameCache.headerImage,
        shortDescription: gameCache.shortDescription,
        steamPrice: gameCache.steamPrice,
        steamInitialPrice: gameCache.steamInitialPrice,
        steamDiscount: gameCache.steamDiscount,
        steamCurrency: gameCache.steamCurrency,
        cheapestPrice: gameCache.cheapestPrice,
        cheapestStore: gameCache.cheapestStore,
        cheapestCurrency: gameCache.cheapestCurrency,
        releaseDate: gameCache.releaseDate,
      })
      .from(gameCache)
      .where(sql`${gameCache.name} ILIKE ${contains}`)
      // Les correspondances en début de nom d'abord (« Valheim » avant
      // « Valheim+ »), puis les noms les plus courts : la recherche exacte
      // remonte avant les dérivés.
      .orderBy(
        sql`CASE WHEN ${gameCache.name} ILIKE ${startsWith} THEN 0 ELSE 1 END`,
        sql`length(${gameCache.name})`,
        gameCache.name,
      )
      .limit(10);

    return res.status(200).json({
      ok: true,
      games: rows.map((r) => ({
        appid: r.appid,
        name: r.name,
        headerImage:
          r.headerImage ??
          `https://cdn.cloudflare.steamstatic.com/steam/apps/${r.appid}/header.jpg`,
        shortDescription: r.shortDescription,
        steamPrice: r.steamPrice,
        steamInitialPrice: r.steamInitialPrice,
        steamDiscount: r.steamDiscount,
        steamCurrency: r.steamCurrency ?? 'EUR',
        cheapestPrice: r.cheapestPrice,
        cheapestStore: r.cheapestStore,
        cheapestCurrency: r.cheapestCurrency ?? 'EUR',
        releaseDate: r.releaseDate,
      })),
    });
  } catch (err: any) {
    console.error('[events/game-search]', err);
    return res.status(500).json({ error: err.message });
  }
}
