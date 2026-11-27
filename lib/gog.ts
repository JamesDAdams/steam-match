/**
 * Client GOG.
 *
 * ATTENTION : GOG n'expose AUCUNE API publique pour les comptes. Tout ce qui
 * suit utilise les services internes du site et du client Galaxy, documentés
 * par la communauté (gogapidocs.readthedocs.io) et utilisés depuis des années
 * par Heroic, Minigalaxy et lgogdownloader. Les identifiants ci-dessous sont
 * ceux du client Galaxy : publics de fait, mais GOG peut les révoquer.
 *
 * CE QUE GOGNE CE CLIENT :
 *   - la liste des jeux possédés (avec titre et jaquette) ;
 *   - PAS le temps de jeu : il n'existe que dans le client, en local.
 */

const AUTH = 'https://auth.gog.com';
const EMBED = 'https://embed.gog.com';

/** Identifiants du client Galaxy (OAuth), publics et stables depuis 2015. */
const CLIENT_ID = process.env.GOG_CLIENT_ID || '46899977096215655';
const CLIENT_SECRET =
  process.env.GOG_CLIENT_SECRET ||
  '9d85c43b1482497dbbce61f6e4aa173a433796eeae2ca8c5f6129f2dc4de46d9';
const REDIRECT_URI = 'https://embed.gog.com/on_login_success?origin=client';

export interface GogTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

/** URL de connexion : le membre s'y connecte puis colle le code reçu. */
export function gogLoginUrl(): string {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    layout: 'client2',
  });
  return `${AUTH}/auth?${params.toString()}`;
}

/**
 * Extrait le code d'un texte collé par le membre : URL de retour complète,
 * champ `code=…`, ou code seul.
 */
export function parseGogCode(input: string): string | null {
  const value = input.trim();
  if (!value) return null;

  // JSON collé (certains outils renvoient {"code":"…"}).
  const json = /"(?:code|authorizationCode)"\s*:\s*"([^"]+)"/i.exec(value);
  if (json) return json[1];

  // URL de retour : le code peut suivre ?, & ou #.
  // La page `on_login_success` reste BLANCHE dans un navigateur normal (elle
  // tente d'ouvrir le client Galaxy) : le code n'existe que dans la barre
  // d'adresse. C'est le cas d'usage principal de ce parseur.
  const fromUrl = /[?&#]code=([A-Za-z0-9_-]{8,})/i.exec(value);
  if (fromUrl) return fromUrl[1];

  if (/^[A-Za-z0-9_-]{10,}$/.test(value)) return value;
  return null;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user_id?: string;
}

async function requestToken(params: Record<string, string>): Promise<TokenResponse> {
  const url = `${AUTH}/token?${new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    ...params,
  }).toString()}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(12_000) });
  if (!res.ok) {
    throw new Error(`GOG a refusé l’authentification (HTTP ${res.status}).`);
  }

  const data = (await res.json()) as TokenResponse;
  if (!data.access_token || !data.refresh_token) {
    throw new Error('Réponse GOG inattendue (jetons absents).');
  }
  return data;
}

function toTokens(data: TokenResponse): GogTokens {
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: new Date(Date.now() + Math.max(60, data.expires_in ?? 3600) * 1000),
  };
}

export async function exchangeGogCode(code: string): Promise<GogTokens> {
  const data = await requestToken({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
  });
  return toTokens(data);
}

export async function refreshGogTokens(refreshToken: string): Promise<GogTokens> {
  const data = await requestToken({ grant_type: 'refresh_token', refresh_token: refreshToken });
  return toTokens(data);
}

export interface GogUser {
  userId: string;
  username: string;
  avatarUrl: string | null;
}

export async function getGogUser(accessToken: string): Promise<GogUser> {
  const res = await fetch(`${EMBED}/userData.json`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`Profil GOG illisible (HTTP ${res.status}).`);

  const data = (await res.json()) as {
    userId?: string;
    username?: string;
    avatar?: string;
  };
  if (!data.userId || !data.username) {
    throw new Error('Profil GOG incomplet : reconnecte le compte.');
  }

  return {
    userId: String(data.userId),
    username: data.username,
    avatarUrl: data.avatar ? normalizeImage(data.avatar) : null,
  };
}

/** Les images GOG arrivent en `//images-2.gog.com/…` (sans schéma). */
function normalizeImage(url: string | undefined | null): string | null {
  if (!url) return null;
  if (url.startsWith('//')) return `https:${url}`;
  if (url.startsWith('http')) return url;
  return `https://images.gog.com/${url}`;
}

export interface GogGame {
  id: string;
  name: string;
  imageUrl: string | null;
}

/**
 * Ludothèque complète, paginée (100 produits par page).
 *
 * On ne garde que les jeux (`mediaType=1`) : films et bandes-son n'ont pas
 * leur place dans une liste de jeux à faire ensemble.
 */
export async function getGogLibrary(accessToken: string): Promise<GogGame[]> {
  const games: GogGame[] = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const url = `${EMBED}/account/getFilteredProducts?mediaType=1&page=${page}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Ludothèque GOG illisible (HTTP ${res.status}).`);

    const data = (await res.json()) as {
      products?: { id?: number | string; title?: string; image?: string; isGame?: boolean }[];
      totalPages?: number;
    };

    for (const p of data.products ?? []) {
      if (!p?.id || !p.title) continue;
      // `isGame: false` = film ou extra : on l'ignore.
      if (p.isGame === false) continue;
      games.push({
        id: String(p.id),
        name: p.title,
        imageUrl: normalizeImage(p.image),
      });
    }

    totalPages = Math.max(1, Number(data.totalPages ?? 1));
    page += 1;
    if (page > 50) break; // garde-fou : jamais 50 pages
  }

  return games;
}
