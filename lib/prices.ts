/**
 * Prix des clés de jeux.
 *
 * Deux sources, par ordre de préférence dans le temps :
 *   1. GG.deals  — nécessite une clé API (GG_DEALS_API_KEY). Prix en euros,
 *      historique, magasins de clés inclus. Optionnel.
 *   2. CheapShark — totalement public, sans clé. Prix en dollars.
 *
 * Le prix est stocké en CENTIMES pour éviter les erreurs d'arrondi flottant.
 */

const CHEAPSHARK = 'https://www.cheapshark.com/api/1.0';

export interface GamePrice {
  /** Prix le plus bas, en centimes. */
  priceCents: number;
  /** Devise ISO : EUR ou USD. */
  currency: string;
  /** Boutique d'où vient le prix (nom lisible si connue). */
  store: string;
}

/**
 * CheapShark exige un User-Agent identifiable, sinon il répond 200 avec un
 * objet d'erreur — piège classique.
 */
async function fromCheapShark(appid: number): Promise<GamePrice | null> {
  try {
    const res = await fetch(`${CHEAPSHARK}/games?steamAppID=${appid}`, {
      headers: { 'User-Agent': 'BastionDesGamers/1.0 (+association gaming)' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;

    const data = (await res.json()) as any;
    if (!Array.isArray(data) || data.length === 0) return null;

    const game = data[0];
    const cheapest = Number(game?.cheapest);
    if (!Number.isFinite(cheapest) || cheapest <= 0) return null;

    // Détail du meilleur deal pour connaître la boutique.
    let storeName = 'Boutique partenaire';
    if (game.cheapestDealID) {
      try {
        // ATTENTION : cheapestDealID arrive DÉJÀ encodé pour l'URL (il contient
        // %3D). Un encodeURIComponent de plus produirait %253D et la requête
        // échouerait silencieusement — plus de nom de boutique.
        const dealRes = await fetch(
          `${CHEAPSHARK}/deals?id=${game.cheapestDealID}`,
          {
            headers: { 'User-Agent': 'BastionDesGamers/1.0' },
            signal: AbortSignal.timeout(8000),
          },
        );
        if (dealRes.ok) {
          const deal = (await dealRes.json()) as any;
          // CheapShark renvoie un identifiant numérique de boutique.
          const storeID = String(deal?.gameInfo?.storeID ?? '');
          storeName = STORE_NAMES[storeID] ?? storeName;
        }
      } catch {
        /* le nom de boutique est un bonus, pas un blocage */
      }
    }

    return {
      priceCents: Math.round(cheapest * 100),
      currency: 'USD',
      store: storeName,
    };
  } catch {
    return null;
  }
}

/** Quelques boutiques fréquentes chez CheapShark. */
const STORE_NAMES: Record<string, string> = {
  '1': 'Steam',
  '2': 'GamersGate',
  '3': 'GreenManGaming',
  '7': 'GOG',
  '8': 'Origin',
  '11': 'Humble Store',
  '13': 'Uplay',
  '15': 'Fanatical',
  '21': 'WinGameStore',
  '23': 'GameBillet',
  '24': 'Voidu',
  '25': 'Epic Games',
  '27': 'Gamesplanet',
  '28': 'Gamesload',
  '29': '2Game',
  '30': 'IndieGala',
  '31': 'Blizzard',
  '33': 'DLGamer',
  '34': 'Noctre',
  '35': 'DreamGame',
};

/**
 * GG.deals — nécessite une clé.
 * Le schéma de réponse n'étant pas documenté publiquement de façon stable,
 * on reste défensif : toute anomalie fait basculer sur CheapShark.
 */
async function fromGGDeals(appid: number): Promise<GamePrice | null> {
  const key = process.env.GG_DEALS_API_KEY;
  if (!key) return null;

  try {
    const res = await fetch(
      `https://api.gg.deals/v1/prices/by-steam-app-id/${appid}/?key=${encodeURIComponent(key)}`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) return null;

    const json = (await res.json()) as any;

    // On cherche le prix le plus bas dans la structure renvoyée.
    const prices: any[] = json?.data?.prices ?? json?.prices ?? [];
    const candidates = prices
      .map((p) => ({
        amount: Number(p?.price?.amount ?? p?.amount),
        currency: String(p?.price?.currency ?? p?.currency ?? 'EUR'),
        shop: String(p?.shop?.name ?? p?.shop?.id ?? 'GG.deals'),
      }))
      .filter((p) => Number.isFinite(p.amount) && p.amount > 0);

    if (candidates.length === 0) return null;

    const best = candidates.sort((a, b) => a.amount - b.amount)[0];

    // Selon les endpoints, le montant est en euros (float) ou en centimes.
    const cents = best.amount < 1000 ? Math.round(best.amount * 100) : Math.round(best.amount);

    return { priceCents: cents, currency: best.currency, store: best.shop };
  } catch {
    return null;
  }
}

/** Prix le plus bas connu pour un jeu, ou null si introuvable. */
export async function fetchCheapestPrice(appid: number): Promise<GamePrice | null> {
  const gg = await fromGGDeals(appid);
  if (gg) return gg;
  return fromCheapShark(appid);
}

/** Formate un prix en centimes pour l'affichage. */
export function formatPrice(priceCents: number, currency: string): string {
  try {
    return new Intl.NumberFormat('fr-FR', {
      style: 'currency',
      currency: currency || 'EUR',
    }).format(priceCents / 100);
  } catch {
    return `${(priceCents / 100).toFixed(2)} €`;
  }
}
