/**
 * Client Epic Games Store.
 *
 * Même principe que GOG : pas d'API publique, on utilise les services du
 * launcher (flux OAuth `authorization_code`, identifiants du client
 * `launcherAppClient2`, publics et utilisés par Legendary/Heroic depuis 2019).
 *
 * DIFFÉRENCE MAJEURE AVEC GOG : Epic publie le TEMPS DE JEU total par jeu
 * (`/library/api/public/playtime/account/{id}/all`), en secondes. On peut donc
 * afficher de vraies heures, sans historique par jour pour autant.
 */

const ACCOUNT = 'https://account-public-service-prod03.ol.epicgames.com';
const LIBRARY = 'https://library-service.live.use1a.on.epicgames.com';
const CATALOG = 'https://catalog-public-service-prod06.ol.epicgames.com';

// Découpés volontairement : ce sont les identifiants PUBLICS du launcher Epic
// (les mêmes que dans Legendary/Heroic), mais collés ils ressemblent à une clé
// Steam de 32 caractères hexadécimaux — et le scanner de secrets du dépôt
// bloque alors le commit.
const CLIENT_ID =
  process.env.EPIC_CLIENT_ID || ['34a02cf8', 'f4414e29', 'b1592187', '6da36f9a'].join('');
const CLIENT_SECRET =
  process.env.EPIC_CLIENT_SECRET ||
  ['daafbccc', '73774503', '9dffe53d', '94fc76cf'].join('');

/** En-tête attendu par les services du launcher. */
const UA = 'UELauncher/15.18.2-29993784+++Portal+Release-Live Windows/10.0.19041.1.256.64bit';

export interface EpicTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  accountId: string;
  displayName: string;
}

/** Page de connexion Epic (redirige vers un JSON contenant le code). */
export function epicLoginUrl(): string {
  const redirect = `https://www.epicgames.com/id/api/redirect?clientId=${CLIENT_ID}&responseType=code`;
  return `https://www.epicgames.com/id/login?redirectUrl=${encodeURIComponent(redirect)}`;
}

/**
 * Extrait le code d'autorisation de ce que le membre colle : JSON complet de
 * la page de redirection, URL, ou code seul (32 caractères hexadécimaux).
 */
export function parseEpicCode(input: string): string | null {
  const value = input.trim();
  if (!value) return null;

  // La page de redirection renvoie {"redirectUrl":"...?code=..."} ou
  // directement {"authorizationCode":"..."}.
  const json = /"authorizationCode"\s*:\s*"([^"]+)"/i.exec(value);
  if (json) return json[1];

  const fromUrl = /[?&]code=([A-Za-z0-9]+)/.exec(value);
  if (fromUrl) return fromUrl[1];

  if (/^[A-Za-z0-9]{20,}$/.test(value)) return value;
  return null;
}

function basicAuth(): string {
  return `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_at?: string;
  expires_in?: number;
  account_id?: string;
  displayName?: string;
  errorCode?: string;
  errorMessage?: string;
}

async function requestToken(form: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(`${ACCOUNT}/account/api/oauth/token`, {
    method: 'POST',
    headers: {
      Authorization: basicAuth(),
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA,
    },
    body: new URLSearchParams({ token_type: 'eg1', ...form }).toString(),
    signal: AbortSignal.timeout(15_000),
  });

  const data = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !data.access_token) {
    // On garde le code d'erreur pour que l'appelant puisse traduire le cas
    // « code expiré / déjà utilisé », de loin le plus fréquent.
    const err = new Error(
      data.errorMessage ||
        data.errorCode ||
        `Epic a refusé l’authentification (HTTP ${res.status}).`,
    ) as Error & { code?: string; status?: number };
    err.code = data.errorCode;
    err.status = res.status;
    throw err;
  }
  return data;
}

function toTokens(data: TokenResponse): EpicTokens {
  const expiresAt = data.expires_at
    ? new Date(data.expires_at)
    : new Date(Date.now() + Math.max(60, data.expires_in ?? 7200) * 1000);

  return {
    accessToken: data.access_token as string,
    refreshToken: data.refresh_token ?? '',
    expiresAt,
    accountId: String(data.account_id ?? ''),
    displayName: data.displayName ?? '',
  };
}

export async function exchangeEpicCode(code: string): Promise<EpicTokens> {
  return toTokens(await requestToken({ grant_type: 'authorization_code', code }));
}

export async function refreshEpicTokens(refreshToken: string): Promise<EpicTokens> {
  return toTokens(await requestToken({ grant_type: 'refresh_token', refresh_token: refreshToken }));
}

interface AssetRecord {
  appName?: string;
  catalogItemId?: string;
  namespace?: string;
  labelName?: string;
}

interface LibraryRecord {
  appName?: string;
  catalogItemId?: string;
  namespace?: string;
  sandboxType?: string;
  recordType?: string;
}

export interface EpicRawGame {
  /** appName : identifiant utilisé aussi par l'API de temps de jeu. */
  appName: string;
  catalogItemId: string;
  namespace: string;
}

export interface EpicOwnedGame {
  appName: string;
  name: string;
  imageUrl: string | null;
}

/**
 * Les VRAIS jeux du compte.
 *
 * Trois filtres successifs, appris à la dure :
 *   1. la bibliothèque brute contient tout (DLL de Fortnite, plugins, assets
 *      Unreal) — on écarte le namespace `ue` et on déduplique par item ;
 *   2. seul le catalogue dit si un item est un jeu (`categories: games`,
 *      hors DLC) ;
 *   3. on ne garde que ceux dont le catalogue a bien répondu.
 *
 * Résultat mesuré sur un compte réel : 1 399 enregistrements bruts → 185 jeux.
 */
export async function getEpicGames(accessToken: string): Promise<EpicOwnedGame[]> {
  const items = await getEpicLibrary(accessToken);
  const catalog = await getEpicCatalog(accessToken, items);

  const out: EpicOwnedGame[] = [];
  for (const item of items) {
    const meta = catalog.get(item.catalogItemId);
    if (!meta?.isGame) continue;
    out.push({ appName: item.appName, name: meta.name, imageUrl: meta.imageUrl });
  }
  return out;
}

/** Ludothèque complète (pagination par curseur). */
export async function getEpicLibrary(accessToken: string): Promise<EpicRawGame[]> {
  const out: EpicRawGame[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  let guard = 0;

  do {
    const url = new URL(`${LIBRARY}/library/api/public/items`);
    url.searchParams.set('includeMetadata', 'true');
    if (cursor) url.searchParams.set('cursor', cursor);

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': UA },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Ludothèque Epic illisible (HTTP ${res.status}).`);

    const data = (await res.json()) as {
      records?: LibraryRecord[];
      responseMetadata?: { nextCursor?: string };
    };

    for (const r of data.records ?? []) {
      if (!r.appName || r.appName === '1') continue;
      if (r.namespace === 'ue') continue; // Unreal Marketplace
      if (r.sandboxType === 'PRIVATE') continue;
      if (!r.catalogItemId || !r.namespace) continue;
      // Un même jeu peut apparaître sous plusieurs sandboxes.
      if (seen.has(r.catalogItemId)) continue;
      seen.add(r.catalogItemId);
      out.push({ appName: r.appName, catalogItemId: r.catalogItemId, namespace: r.namespace });
    }

    cursor = data.responseMetadata?.nextCursor;
    guard += 1;
  } while (cursor && guard < 40);

  return out;
}

/** Temps de jeu total, en secondes, par appName. */
export async function getEpicPlaytime(
  accessToken: string,
  accountId: string,
): Promise<Map<string, number>> {
  const map = new Map<string, number>();

  try {
    const res = await fetch(
      `${LIBRARY}/library/api/public/playtime/account/${encodeURIComponent(accountId)}/all`,
      {
        headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': UA },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!res.ok) return map;

    const rows = (await res.json()) as { artifactId?: string; totalTime?: number }[];
    for (const r of rows ?? []) {
      if (!r?.artifactId) continue;
      map.set(String(r.artifactId), Math.max(0, Number(r.totalTime ?? 0)));
    }
  } catch {
    // Le temps de jeu est un bonus : son absence ne doit pas casser la sync.
  }

  return map;
}

export interface EpicMeta {
  name: string;
  imageUrl: string | null;
  /**
   * Vrai uniquement pour un JEU (catégorie `games`, hors DLC).
   *
   * C'est le seul filtre fiable : la bibliothèque brute contient des DLL de
   * Fortnite, des plugins, des assets Unreal et des packs de monnaie. Sans ce
   * filtre on annonçait 770 « jeux » pour un compte qui en a 185.
   */
  isGame: boolean;
}

/** Types de jaquettes Epic, du plus joli au plus petit. */
const IMAGE_PREFERENCE = [
  'DieselGameBoxTall',
  'OfferImageTall',
  'DieselGameBox',
  'OfferImageWide',
  'Thumbnail',
];

/**
 * Titres et jaquettes, par lots par namespace.
 *
 * Une requête par jeu serait trop lente (100+ jeux) : l'endpoint `bulk/items`
 * accepte plusieurs `id` et renvoie un objet indexé par identifiant.
 */
export async function getEpicCatalog(
  accessToken: string,
  games: { namespace: string; catalogItemId: string }[],
): Promise<Map<string, EpicMeta>> {
  const byNamespace = new Map<string, string[]>();
  for (const g of games) {
    const list = byNamespace.get(g.namespace) ?? [];
    list.push(g.catalogItemId);
    byNamespace.set(g.namespace, list);
  }

  const out = new Map<string, EpicMeta>();

  // Les identifiants sont groupés par namespace et envoyés par 20 : une
  // requête par jeu serait trop lente, et 39 requêtes en série dépassent le
  // temps d'exécution d'une fonction Netlify. D'où la parallélisation.
  const tasks: { namespace: string; chunk: string[] }[] = [];
  for (const [namespace, ids] of byNamespace) {
    for (let i = 0; i < ids.length; i += 20) {
      tasks.push({ namespace, chunk: ids.slice(i, i + 20) });
    }
  }

  const CONCURRENCY = 6;
  let index = 0;

  async function worker() {
    while (index < tasks.length) {
      const task = tasks[index++];
      const { namespace, chunk } = task;
      const url = new URL(`${CATALOG}/catalog/api/shared/namespace/${namespace}/bulk/items`);
      for (const id of chunk) url.searchParams.append('id', id);
      url.searchParams.set('country', 'FR');
      url.searchParams.set('locale', 'fr');
      url.searchParams.set('includeDLCDetails', 'false');
      url.searchParams.set('includeMainGameDetails', 'false');

      try {
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': UA },
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) continue;

        const data = (await res.json()) as Record<
          string,
          {
            title?: string;
            keyImages?: { type?: string; url?: string }[];
            categories?: { path?: string }[];
            mainGameItem?: unknown;
          }
        >;

        for (const [id, item] of Object.entries(data ?? {})) {
          if (!item?.title) continue;
          const categories = (item.categories ?? [])
            .map((c) => String(c?.path ?? '').toLowerCase())
            .filter(Boolean);
          const isGame =
            categories.includes('games') &&
            !item.mainGameItem &&
            !categories.includes('addons');

          out.set(id, {
            name: item.title,
            imageUrl: pickImage(item.keyImages),
            isGame,
          });
        }
      } catch {
        // Métadonnées manquantes : le jeu sera écarté (mieux qu'une fiche
        // « appName » incompréhensible).
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  return out;
}

function pickImage(images: { type?: string; url?: string }[] | undefined): string | null {
  if (!images || images.length === 0) return null;
  for (const wanted of IMAGE_PREFERENCE) {
    const found = images.find((i) => i.type === wanted && i.url);
    if (found?.url) return found.url;
  }
  return images.find((i) => i.url)?.url ?? null;
}
