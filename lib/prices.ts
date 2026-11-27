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

import { rateLimitedFetch } from './rate-limit.ts';

const CHEAPSHARK = 'https://www.cheapshark.com/api/1.0';

export interface GamePrice {
  /** Prix le plus bas, en centimes. */
  priceCents: number;
  /** Devise ISO : EUR ou USD. */
  currency: string;
  /** Boutique d'où vient le prix (nom lisible si connue). */
  store: string;
}

/** Identifiant de Steam dans CheapShark : ce n'est pas un revendeur de clés. */
const STEAM_STORE_ID = '1';

/**
 * Prix chez un REVENDEUR de clés (jamais Steam lui-même).
 *
 * POURQUOI FILTRER STEAM :
 * CheapShark renvoie le meilleur prix toutes boutiques confondues, et c'est
 * très souvent Steam en promotion. Afficher ça comme « prix en clé » serait
 * faux — et parfois plus cher que le prix Steam officiel du pays, ce qui
 * n'aurait aucun sens pour l'utilisateur.
 *
 * On ne garde donc que les boutiques tierces. Si le jeu n'est vendu que sur
 * Steam, il n'y a pas de prix en clé : on renvoie null.
 */
async function fromCheapShark(appid: number): Promise<GamePrice | null> {
  try {
    const headers = { 'User-Agent': 'BastionDesGamers/1.0 (+association gaming)' };

    // UN SEUL appel : /deals?steamAppID= renvoie déjà toutes les boutiques.
    // L'ancienne méthode (games?steamAppID pour obtenir le gameID, puis
    // games?id pour les offres) coûtait deux requêtes par jeu — c'était le
    // principal goulot de l'enrichissement.
    const res = await rateLimitedFetch(
      `${CHEAPSHARK}/deals?steamAppID=${appid}&pageSize=60`,
      { headers, signal: AbortSignal.timeout(5000) },
    );
    if (!res.ok) return null;

    const deals = (await res.json()) as any[];
    if (!Array.isArray(deals) || deals.length === 0) return null;

    // On écarte Steam et on prend la moins chère des boutiques de clés.
    const thirdParty = deals
      .filter((d) => String(d?.storeID) !== STEAM_STORE_ID)
      .map((d) => ({
        storeID: String(d.storeID ?? ''),
        price: Number(d.salePrice),
      }))
      .filter((d) => Number.isFinite(d.price) && d.price > 0)
      .sort((a, b) => a.price - b.price);

    if (thirdParty.length === 0) return null;

    const best = thirdParty[0];
    return {
      priceCents: Math.round(best.price * 100),
      currency: 'USD',
      store: STORE_NAMES[best.storeID] ?? 'Revendeur',
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
 * GG.deals — prix des boutiques de clés, en euros.
 *
 * L'API a changé de forme (constaté en novembre 2026) : l'identifiant Steam
 * **ne fait plus partie du chemin**. Il passe en paramètre `ids` (plusieurs
 * identifiants séparés par des virgules) et `region=fr` renvoie des euros.
 *
 *   GET https://api.gg.deals/v1/prices/by-steam-app-id/?ids=892970&region=fr&key=…
 *   → { data: { "892970": { prices: { currentKeyshops: "16.50", currency: "EUR" } } } }
 *
 * `currentKeyshops` est le prix « en clé » ; `currentRetail` correspond aux
 * boutiques officielles (Steam, GOG…) : ce n'est pas ce qu'on affiche.
 * L'ancienne forme (`/v1/prices/by-steam-app-id/<appid>/`) répond 404 : d'où
 * l'absence de prix en clé tant qu'elle n'était pas corrigée.
 */
/**
 * Quota GG.deals : « 1000 jeux par heure » sur l'offre gratuite. Quand il est
 * atteint, inutile d'insister : on met la source en pause un quart d'heure et
 * on garde le prix déjà en cache (on ne le remplace surtout pas par un prix
 * CheapShark en dollars).
 */
let ggdealsPausedUntil = 0;

/** Vrai si la clé GG.deals est configurée : c'est notre source de référence. */
export function hasGGDealsKey(): boolean {
  return Boolean(process.env.GG_DEALS_API_KEY);
}

async function fromGGDeals(appid: number): Promise<GamePrice | null> {
  const key = process.env.GG_DEALS_API_KEY;
  if (!key) return null;
  if (Date.now() < ggdealsPausedUntil) return null;

  try {
    const res = await rateLimitedFetch(
      `https://api.gg.deals/v1/prices/by-steam-app-id/?ids=${appid}` +
        `&region=fr&key=${encodeURIComponent(key)}`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (res.status === 429) {
      ggdealsPausedUntil = Date.now() + 15 * 60_000;
      console.warn('[prix] quota GG.deals atteint — pause de 15 min');
      return null;
    }
    if (!res.ok) return null;

    const json = (await res.json()) as any;
    const prices = json?.data?.[String(appid)]?.prices;
    if (!prices) return null;

    // currentKeyshops = meilleur prix chez un revendeur de clés.
    const amount = Number(prices.currentKeyshops);
    if (!Number.isFinite(amount) || amount <= 0) return null;

    return {
      priceCents: Math.round(amount * 100),
      currency: String(prices.currency ?? 'EUR').toUpperCase(),
      store: 'GG.deals',
    };
  } catch {
    return null;
  }
}

export interface SteamPrice {
  /** Prix actuel en centimes. */
  priceCents: number;
  /** Prix de base (avant remise) en centimes. */
  initialCents: number;
  /** Remise en pourcentage, 0 si pas de promo. */
  discountPercent: number;
  currency: string;
  /** Date de sortie telle qu'affichée par Steam (ex. « 24 févr. 2022 »). */
  releaseDate: string | null;
  /** Jaquette du jeu, quand le Store la renvoie. */
  headerImage?: string | null;
  /** Modes de jeu lisibles : Solo, Multijoueur, Coopération… */
  playModes: string[];
}

/**
 * Catégories Steam qui nous intéressent pour savoir comment on joue.
 * On ne garde que celles-ci : la liste complète contient 20 entrées
 * techniques (Steam Cloud, Cartes à échanger…) sans intérêt ici.
 */
const PLAY_MODE_KEYWORDS = [
  'solo',
  'multijoueur',
  'multi-joueur',
  'coopération',
  'cooperation',
  'co-op',
  'pvp',
  'jcj',
  'écran partagé',
  'local',
];

function extractPlayModes(categories: { description?: string }[] = []): string[] {
  return categories
    .map((c) => c.description)
    .filter((d): d is string => Boolean(d))
    .filter((d) => {
      const low = d.toLowerCase();
      return PLAY_MODE_KEYWORDS.some((k) => low.includes(k));
    })
    // On garde les plus parlantes en tête.
    .sort((a, b) => a.length - b.length)
    .slice(0, 4);
}

/**
 * Prix officiel sur le Store Steam, en euros.
 *
 * On demande explicitement cc=fr pour obtenir l'EUR plutôt que l'USD par
 * défaut. Les jeux gratuits n'ont pas de price_overview : on renvoie null,
 * ce qui n'est pas une erreur.
 */
export async function fetchSteamPrice(appid: number): Promise<SteamPrice | null> {
  try {
    const res = await rateLimitedFetch(
      `https://store.steampowered.com/api/appdetails?appids=${appid}` +
        `&filters=basic,price_overview,release_date,categories&cc=fr&l=french`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (res.status === 429 || !res.ok) return null;

    const json = (await res.json()) as Record<string, { success?: boolean; data?: any }>;
    const entry = json[String(appid)];
    if (!entry?.success) return null;

    const data = entry.data ?? {};
    const p = data.price_overview;
    const releaseDate = data.release_date?.date ?? null;
    const playModes = extractPlayModes(data.categories);

    // Jeu gratuit : pas de price_overview, mais on veut quand même la date
    // et les modes de jeu.
    if (!p) {
      if (!releaseDate && playModes.length === 0) return null;
      return {
        priceCents: 0,
        initialCents: 0,
        discountPercent: 0,
        currency: 'EUR',
        releaseDate,
        headerImage: data.header_image ?? null,
        playModes,
      };
    }

    return {
      priceCents: Number(p.final ?? 0),
      initialCents: Number(p.initial ?? p.final ?? 0),
      discountPercent: Number(p.discount_percent ?? 0),
      currency: String(p.currency ?? 'EUR'),
      releaseDate,
      headerImage: data.header_image ?? null,
      playModes,
    };
  } catch {
    return null;
  }
}

/**
 * Prix « en clé » d'un jeu, ou null s'il n'y en a pas.
 *
 * GG.deals est la référence (boutiques de clés, euros). CheapShark ne sert de
 * secours que si aucune clé GG.deals n'est configurée : ses prix viennent de
 * boutiques tierces en dollars, ce qui n'est pas la même chose.
 */
export async function fetchCheapestPrice(appid: number): Promise<GamePrice | null> {
  const gg = await fromGGDeals(appid);
  if (gg) return gg;
  if (hasGGDealsKey()) return null;
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
