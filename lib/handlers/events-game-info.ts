import { requireAdmin } from '../access.ts';
import { getDb } from '../../db/index.ts';
import { gameCache } from '../../db/schema.ts';
import { eq, sql } from 'drizzle-orm';
import { rateLimitedFetch } from '../rate-limit.ts';
import { fetchCheapestPrice } from '../prices.ts';

/**
 * GET /api/events/game-info?appid=892970
 *
 * Fiche complète d'un jeu pour préremplir un événement : description, jaquette
 * et prix.
 *
 * POURQUOI CETTE ROUTE EXISTE : le cache ne contient pas toujours ces champs.
 * Les jeux enrichis avant l'ajout de `short_description` au filtre du Store
 * (et la totalité des jaquettes) sont vides — constaté sur la bibliothèque :
 * 10 descriptions pour 470 jeux. Plutôt que de relancer un enrichissement
 * complet (des centaines d'appels), on complète **à la demande**, une fois par
 * jeu, et on réécrit le cache : la fiche est instantanée les fois suivantes.
 */
const STORE = 'https://store.steampowered.com/api/appdetails';

export default async function handler(req: any, res: any) {
  if ((req.method || 'GET').toUpperCase() !== 'GET') {
    return res.status(405).json({ error: `Méthode ${req.method} non supportée.` });
  }

  const ctx = await requireAdmin(req, res);
  if (!ctx) return;

  const appid = Number(req.query?.appid);
  if (!Number.isInteger(appid) || appid <= 0) {
    return res.status(400).json({ error: 'Identifiant de jeu invalide.' });
  }

  const headerFallback = `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`;

  try {
    const db = getDb();
    const [row] = await db
      .select({
        appid: gameCache.appid,
        name: gameCache.name,
        headerImage: gameCache.headerImage,
        shortDescription: gameCache.shortDescription,
        steamPrice: gameCache.steamPrice,
        steamCurrency: gameCache.steamCurrency,
        steamDiscount: gameCache.steamDiscount,
        cheapestPrice: gameCache.cheapestPrice,
        cheapestStore: gameCache.cheapestStore,
        cheapestCurrency: gameCache.cheapestCurrency,
      })
      .from(gameCache)
      .where(eq(gameCache.appid, appid))
      .limit(1);

    if (!row) {
      return res.status(404).json({ error: 'Ce jeu n’est pas dans la bibliothèque.' });
    }

    let { shortDescription, headerImage } = row;

    // Complément à la demande : uniquement si l'un des deux manque.
    if (!shortDescription || !headerImage) {
      const fresh = await fetchStore(appid);
      if (fresh) {
        shortDescription = shortDescription ?? fresh.short_description ?? null;
        headerImage = headerImage ?? fresh.header_image ?? null;

        // On profite du passage pour réparer le cache (jamais d'écrasement
        // d'une valeur déjà présente : le cache reste la référence).
        await db
          .update(gameCache)
          .set({
            shortDescription: sql`COALESCE(${gameCache.shortDescription}, ${shortDescription})`,
            headerImage: sql`COALESCE(${gameCache.headerImage}, ${headerImage})`,
          })
          .where(eq(gameCache.appid, appid))
          .catch(() => undefined);
      }
    }

    /**
     * Prix en clé absent du cache (jeu jamais enrichi, ou prix récupéré à
     * l'époque où l'API GG.deals ne répondait plus) : on le demande
     * maintenant, une fois, et on répare le cache. Sans ça, la fenêtre de
     * création d'événement affichait « pas de prix » pour toujours.
     */
    let cheapestPrice = row.cheapestPrice;
    let cheapestStore = row.cheapestStore;
    let cheapestCurrency = row.cheapestCurrency;

    if (cheapestPrice === null || cheapestPrice === undefined) {
      const price = await fetchCheapestPrice(appid).catch(() => null);
      if (price) {
        cheapestPrice = price.priceCents;
        cheapestStore = price.store;
        cheapestCurrency = price.currency;
        await db
          .update(gameCache)
          .set({
            cheapestPrice: price.priceCents,
            cheapestStore: price.store,
            cheapestCurrency: price.currency,
            priceUpdatedAt: new Date(),
          })
          .where(eq(gameCache.appid, appid))
          .catch(() => undefined);
      }
    }

    return res.status(200).json({
      ok: true,
      game: {
        appid: row.appid,
        name: row.name,
        headerImage: headerImage ?? headerFallback,
        shortDescription: shortDescription ?? null,
        steamPrice: row.steamPrice,
        steamDiscount: row.steamDiscount,
        steamCurrency: row.steamCurrency ?? 'EUR',
        cheapestPrice,
        cheapestStore,
        cheapestCurrency: cheapestCurrency ?? 'EUR',
      },
    });
  } catch (err: any) {
    console.error('[events/game-info]', err);
    return res.status(500).json({ error: err.message });
  }
}

/** Lecture du Store Steam, espacée par le limiteur de débit partagé. */
async function fetchStore(
  appid: number,
): Promise<{ short_description?: string; header_image?: string } | null> {
  try {
    const url = `${STORE}?appids=${appid}&l=french&filters=basic,short_description`;
    const res = await rateLimitedFetch(url, { signal: AbortSignal.timeout(6_000) });
    if (res.status === 429 || !res.ok) return null;

    const json = (await res.json()) as Record<
      string,
      { success?: boolean; data?: any }
    >;
    const entry = json[String(appid)];
    if (!entry?.success || !entry.data) return null;
    return entry.data;
  } catch {
    return null;
  }
}
