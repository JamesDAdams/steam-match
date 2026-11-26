/**
 * Client pour l'API Steam.
 *
 * Deux choses distinctes, souvent confondues :
 *   1. OPENID (authentification) : ne nécessite aucune clé, et ne renvoie QUE
 *      le SteamID de l'utilisateur. Rien d'autre — ni jeux, ni temps de jeu.
 *   2. WEB API (données) : nécessite STEAM_API_KEY, et renvoie la ludothèque
 *      et les temps de jeu via GetOwnedGames.
 *
 * Steam n'a PAS d'OAuth. OpenID 2.0 est le seul mécanisme, d'où le flux
 * un peu archaïque ci-dessous.
 */

const OPENID_LOGIN = 'https://steamcommunity.com/openid/login';
const OPENID_NS = 'http://specs.openid.net/auth/2.0';
const API_BASE = 'https://api.steampowered.com';
const STORE_BASE = 'https://store.steampowered.com/api';

function requireKey(): string {
  const k = process.env.STEAM_API_KEY;
  if (!k || k.length < 20) {
    throw new Error('STEAM_API_KEY manquant ou invalide (voir .env.local).');
  }
  return k;
}

function baseUrl(): string {
  const u = process.env.BASE_URL || 'http://localhost:3000';
  return u.replace(/\/+$/, '');
}

/* ─────────────────────────── OpenID ─────────────────────────── */

export function buildLoginUrl(returnTo?: string) {
  const params = new URLSearchParams({
    'openid.ns': OPENID_NS,
    'openid.mode': 'checkid_setup',
    'openid.return_to': `${baseUrl()}/api/auth/callback${
      returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ''
    }`,
    'openid.realm': baseUrl(),
    'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
    'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select',
  });
  return `${OPENID_LOGIN}?${params.toString()}`;
}

/**
 * VÉRIFICATION OBLIGATOIRE.
 *
 * Le callback nous donne un claimed_id contenant le SteamID, mais il vient du
 * client : n'importe qui peut forger cette requête. Il faut revalider auprès
 * de Steam avant d'accorder une session. Sans cette étape, on accepte
 * l'usurpation d'identité.
 */
export async function verifyOpenIdResponse(
  query: Record<string, string>,
): Promise<string | null> {
  if (query['openid.mode'] !== 'id_res') return null;

  const body = new URLSearchParams(query);
  body.set('openid.mode', 'check_authentication');

  const res = await fetch(OPENID_LOGIN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const text = await res.text();

  if (!text.includes('is_valid:true')) return null;

  const claimed = query['openid.claimed_id'] ?? '';
  const m = claimed.match(/\/openid\/id\/(\d{17})$/);
  if (!m) return null;

  // On vérifie aussi que le realm correspond, sinon une réponse valide
  // destinée à un autre site pourrait être rejouée ici.
  const realm = query['openid.realm'] ?? query['openid.return_to'] ?? '';
  const expectedRealm = `${baseUrl()}/api/auth/callback`;
  if (!realm.startsWith(expectedRealm)) return null;

  return m[1];
}

/* ─────────────────────────── Web API ─────────────────────────── */

export interface SteamSummary {
  steamid: string;
  personaName: string;
  avatarUrl?: string;
  profileUrl?: string;
  /** 1 privé, 2 amis seulement, 3 public */
  visibility: number;
}

export async function getPlayerSummaries(
  steamids: string[],
): Promise<Map<string, SteamSummary>> {
  if (steamids.length === 0) return new Map();

  const url = `${API_BASE}/ISteamUser/GetPlayerSummaries/v2/?key=${requireKey()}&steamids=${steamids.join(
    ',',
  )}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GetPlayerSummaries a échoué : HTTP ${res.status}`);

  const data = (await res.json()) as {
    response?: { players?: any[] };
  };
  const out = new Map<string, SteamSummary>();

  for (const p of data.response?.players ?? []) {
    out.set(p.steamid, {
      steamid: p.steamid,
      personaName: p.personaname ?? `Joueur ${p.steamid.slice(-4)}`,
      avatarUrl: p.avatarmedium || p.avatar,
      profileUrl: p.profileurl,
      visibility: p.communityvisibilitystate ?? 1,
    });
  }
  return out;
}

export interface OwnedGameRaw {
  appid: number;
  name?: string;
  img_icon_url?: string;
  playtime_forever: number;
  playtime_2weeks?: number;
  /**
   * Horodatage Unix du dernier lancement.
   *
   * C'est le SEUL indicateur rétroactif de Steam : `playtime_2weeks` couvre
   * 14 jours et le cumul ne dit pas quand on a joué. Absent (ou 0) pour un jeu
   * jamais lancé.
   */
  rtime_last_played?: number;
}

/**
 * GetOwnedGames.
 *
 * include_appinfo=1 donne le nom et l'icône, mais JAMAIS les genres.
 * playtime_forever n'est renseigné que si le profil est public ET que
 * « Détails du jeu » est réglé sur public. Sinon : 0 partout.
 */
export async function getOwnedGames(steamid: string): Promise<{
  games: OwnedGameRaw[];
  gamesVisible: boolean;
}> {
  const params = new URLSearchParams({
    key: requireKey(),
    steamid,
    format: 'json',
    include_appinfo: '1',
    include_played_free_games: '1',
    include_free_sub: '0',
    skip_unvetted_apps: '0',
    language: 'french',
  });

  const res = await fetch(`${API_BASE}/IPlayerService/GetOwnedGames/v1/?${params}`);

  // 401/403 = clé invalide. Autre cas fréquent : corps vide si profil privé.
  if (!res.ok) {
    throw new Error(`GetOwnedGames a échoué : HTTP ${res.status}`);
  }

  const data = (await res.json()) as {
    response?: { game_count?: number; games?: OwnedGameRaw[] };
  };

  const games = data.response?.games ?? [];
  if (games.length === 0) {
    return { games: [], gamesVisible: false };
  }

  // Heuristique : si AUCUN jeu n'a de temps de jeu, les détails sont masqués
  // (le profil est peut-être visible mais pas les détails des jeux).
  const gamesVisible = games.some((g) => (g.playtime_forever ?? 0) > 0);
  return { games, gamesVisible };
}

/* ─────────────────────────── Wishlist ─────────────────────────── */

export interface WishlistEntry {
  appid: number;
  priority: number;
}

/**
 * IWishlistService/GetWishlist
 *
 * Renvoie la liste des appids souhaités. Nécessite la clé API et une wishlist
 * publique : sinon Steam renvoie une liste vide, sans erreur explicite.
 *
 * Endpoint relativement récent — s'il n'est pas disponible pour la clé ou le
 * compte, on renvoie une liste vide plutôt que de casser tout le sync.
 */
export async function getWishlist(steamid: string): Promise<{
  items: WishlistEntry[];
  wishlistVisible: boolean;
}> {
  try {
    const params = new URLSearchParams({
      key: requireKey(),
      steamid,
      format: 'json',
    });

    const res = await fetch(
      `${API_BASE}/IWishlistService/GetWishlist/v1/?${params.toString()}`,
    );
    if (!res.ok) return { items: [], wishlistVisible: false };

    const data = (await res.json()) as {
      response?: { items?: { appid: number; priority?: number }[] };
    };

    const items = (data.response?.items ?? [])
      .filter((i) => typeof i?.appid === 'number')
      .map((i) => ({ appid: i.appid, priority: i.priority ?? 0 }));

    return { items, wishlistVisible: items.length > 0 };
  } catch {
    // Endpoint indisponible ou réseau : on n'empêche pas le sync des jeux.
    return { items: [], wishlistVisible: false };
  }
}

/* ─────────────────── Métadonnées du Store (genres) ─────────────────── */

export interface AppDetails {
  appid: number;
  name: string;
  headerImage?: string;
  genres: string[];
  tags: string[];
  shortDescription?: string;
}

/**
 * appdetails : la SEULE source pour les genres/tags.
 *
 * Non keyée, lente (~200 ms), et fortement limitée en débit
 * (environ 200 requêtes / 5 min, sinon HTTP 429).
 * C'est précisément pour ça qu'on passe par game_cache : chaque appid est
 * enrichi une seule fois puis réutilisé pour tout le monde.
 */
export async function getAppDetails(appid: number): Promise<AppDetails | null> {
  const url = `${STORE_BASE}/appdetails?appids=${appid}&l=french&filters=genres,basic,categories,short_description`;

  try {
    const res = await fetch(url);
    if (res.status === 429) return null; // on retentera plus tard
    if (!res.ok) return null;

    const json = (await res.json()) as Record<
      string,
      { success?: boolean; data?: any }
    >;
    const entry = json[String(appid)];
    if (!entry?.success || !entry.data) return null;

    const d = entry.data;
    return {
      appid,
      name: d.name ?? `App ${appid}`,
      headerImage: d.header_image,
      genres: (d.genres ?? []).map((g: any) => g.description).filter(Boolean),
      // On garde peu de tags : les plus signalés, pour éviter le bruit.
      tags: (d.categories ?? []).map((c: any) => c.description).filter(Boolean),
      shortDescription: d.short_description,
    };
  } catch {
    return null;
  }
}

/** Petite pause entre deux appels pour ne pas se faire bannir par le Store. */
export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
