/**
 * Statut des chaînes Twitch.
 *
 * DEUX CHEMINS, UNE SEULE INTERFACE :
 *
 *  1. Twitch Helix (officiel) dès que TWITCH_CLIENT_ID et TWITCH_CLIENT_SECRET
 *     sont renseignés : on obtient tout (titre, jeu, spectateurs, miniature).
 *
 *  2. Sinon, repli sans clé sur l'API GraphQL publique utilisée par twitch.tv
 *     elle-même (un seul appel pour toutes les chaînes). On obtient le même
 *     niveau d'information : avatar, titre, jeu, spectateurs, miniature.
 *
 * Dans les deux cas le résultat est mis en cache 60 s : la page se rafraîchit
 * d'elle-même et plusieurs visiteurs ne doivent pas multiplier les appels.
 */

const HELIX = 'https://api.twitch.tv/helix';
const OAUTH = 'https://id.twitch.tv/oauth2/token';
const GQL = 'https://gql.twitch.tv/gql';
/**
 * Identifiant public du client web de Twitch (celui qu'utilise twitch.tv).
 * Ce n'est pas une clé secrète : il sert uniquement à interroger les données
 * publiques des chaînes, sans compte ni consentement.
 */
const GQL_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';

const CACHE_TTL_MS = 60_000;

export interface TwitchChannelState {
  login: string;
  displayName: string | null;
  avatarUrl: string | null;
  isLive: boolean;
  /** Champs présents seulement avec Helix (ou selon le repli). */
  title?: string | null;
  game?: string | null;
  viewers?: number | null;
  startedAt?: string | null;
  thumbnailUrl?: string | null;
  /** null = chaîne inconnue côté Twitch. */
  exists: boolean;
}

export function isTwitchConfigured(): boolean {
  return Boolean(process.env.TWITCH_CLIENT_ID && process.env.TWITCH_CLIENT_SECRET);
}

/* ─────────────────────────── Jeton applicatif ─────────────────────────── */

let tokenCache: { value: string; expiresAt: number } | null = null;

async function appToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt) return tokenCache.value;

  const params = new URLSearchParams({
    client_id: process.env.TWITCH_CLIENT_ID as string,
    client_secret: process.env.TWITCH_CLIENT_SECRET as string,
    grant_type: 'client_credentials',
  });

  const res = await fetch(`${OAUTH}?${params}`, {
    method: 'POST',
    signal: AbortSignal.timeout(6_000),
  });
  if (!res.ok) throw new Error(`OAuth Twitch : HTTP ${res.status}`);

  const json = (await res.json()) as { access_token: string; expires_in: number };
  // Marge de sécurité : le jeton est renouvelé un peu avant l'expiration.
  tokenCache = {
    value: json.access_token,
    expiresAt: Date.now() + Math.max(60_000, (json.expires_in - 300) * 1000),
  };
  return tokenCache.value;
}

async function helix<T>(path: string, params: Record<string, string[]>): Promise<T> {
  const token = await appToken();
  const qs = new URLSearchParams();
  for (const [key, values] of Object.entries(params)) {
    for (const v of values) qs.append(key, v);
  }

  const res = await fetch(`${HELIX}${path}?${qs}`, {
    headers: {
      'Client-Id': process.env.TWITCH_CLIENT_ID as string,
      Authorization: `Bearer ${token}`,
    },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`Helix ${path} : HTTP ${res.status}`);
  return (await res.json()) as T;
}

/* ─────────────────────────────── Helix ─────────────────────────────── */

async function viaHelix(logins: string[]): Promise<Record<string, TwitchChannelState>> {
  const [usersRes, streamsRes] = await Promise.all([
    helix<{ data: any[] }>('/users', { login: logins }),
    helix<{ data: any[] }>('/streams', { user_login: logins }),
  ]);

  const streams = new Map<string, any>(
    (streamsRes.data ?? []).map((s) => [String(s.user_login).toLowerCase(), s]),
  );

  const out: Record<string, TwitchChannelState> = {};

  for (const u of usersRes.data ?? []) {
    const login = String(u.login).toLowerCase();
    const stream = streams.get(login);
    out[login] = {
      login,
      displayName: u.display_name ?? null,
      avatarUrl: u.profile_image_url ?? null,
      isLive: Boolean(stream),
      exists: true,
      title: stream?.title ?? null,
      game: stream?.game_name ?? null,
      viewers: typeof stream?.viewer_count === 'number' ? stream.viewer_count : null,
      startedAt: stream?.started_at ?? null,
      thumbnailUrl: stream?.thumbnail_url
        ? String(stream.thumbnail_url)
            .replace('{width}', '640')
            .replace('{height}', '360')
        : null,
    };
  }

  // Les chaînes absentes de la réponse n'existent pas.
  for (const login of logins) {
    if (!out[login]) {
      out[login] = {
        login,
        displayName: null,
        avatarUrl: null,
        isLive: false,
        exists: false,
      };
    }
  }

  return out;
}

/* ──────────────────── Repli sans clé (GraphQL public) ──────────────────── */

interface GqlUser {
  id: string;
  login: string;
  displayName: string;
  profileImageURL: string | null;
  stream: {
    title: string | null;
    viewersCount: number | null;
    createdAt: string | null;
    previewImageURL: string | null;
    game: { name: string } | null;
  } | null;
}

async function viaPublicGql(
  logins: string[],
): Promise<Record<string, TwitchChannelState>> {
  const out: Record<string, TwitchChannelState> = {};

  // Twitch limite la taille des requêtes : on regroupe par 20 chaînes.
  const CHUNK = 20;
  for (let i = 0; i < logins.length; i += CHUNK) {
    const slice = logins.slice(i, i + CHUNK);

    const query =
      'query{' +
      slice
        .map(
          (login, idx) =>
            `u${idx}:user(login:${JSON.stringify(login)}){id login displayName profileImageURL(width:150) ` +
            `stream{title viewersCount createdAt previewImageURL(width:640) game{name}}}`,
        )
        .join(' ') +
      '}';

    const res = await fetch(GQL, {
      method: 'POST',
      headers: { 'Client-ID': GQL_CLIENT_ID, 'Content-Type': 'application/json' },
      body: JSON.stringify([{ query, variables: {} }]),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`GraphQL Twitch : HTTP ${res.status}`);

    const payload = (await res.json()) as { data?: Record<string, GqlUser | null> }[];
    const data = payload?.[0]?.data ?? {};

    slice.forEach((login, idx) => {
      const user = data[`u${idx}`];
      if (!user) {
        out[login] = {
          login,
          displayName: null,
          avatarUrl: null,
          isLive: false,
          exists: false,
        };
        return;
      }

      const stream = user.stream;
      out[login] = {
        login: String(user.login).toLowerCase(),
        displayName: user.displayName ?? null,
        avatarUrl: user.profileImageURL ?? null,
        isLive: Boolean(stream),
        exists: true,
        title: stream?.title ?? null,
        game: stream?.game?.name ?? null,
        viewers: typeof stream?.viewersCount === 'number' ? stream.viewersCount : null,
        startedAt: stream?.createdAt ?? null,
        thumbnailUrl: stream?.previewImageURL ?? null,
      };
    });
  }

  return out;
}

/* ─────────────────────────────── Cache ─────────────────────────────── */

const cache = new Map<string, { at: number; value: TwitchChannelState }>();

/**
 * Statut des chaînes demandées. Les entrées fraîches (< 60 s) sont servies
 * depuis le cache ; seules les autres déclenchent un appel.
 */
export async function getChannelsState(
  logins: string[],
): Promise<Record<string, TwitchChannelState>> {
  const wanted = [...new Set(logins.map((l) => l.toLowerCase()).filter(Boolean))];
  const out: Record<string, TwitchChannelState> = {};
  if (wanted.length === 0) return out;

  const now = Date.now();
  const stale = wanted.filter((l) => {
    const hit = cache.get(l);
    if (hit && now - hit.at < CACHE_TTL_MS) {
      out[l] = hit.value;
      return false;
    }
    return true;
  });

  if (stale.length === 0) return out;

  let fresh: Record<string, TwitchChannelState>;
  try {
    fresh = isTwitchConfigured() ? await viaHelix(stale) : await viaPublicGql(stale);
  } catch (err: any) {
    // En cas d'échec, on renvoie ce qu'on a en cache plutôt qu'une erreur :
    // la page reste lisible même si Twitch est momentanément indisponible.
    console.warn('[twitch] statut indisponible :', err?.message);
    for (const login of stale) {
      out[login] =
        cache.get(login)?.value ??
        {
          login,
          displayName: null,
          avatarUrl: null,
          isLive: false,
          exists: true,
        };
    }
    return out;
  }

  for (const [login, state] of Object.entries(fresh)) {
    cache.set(login, { at: now, value: state });
    out[login] = state;
  }

  return out;
}

/** Vérifie qu'une chaîne existe (utilisé au moment de lier son compte). */
export async function checkChannelExists(login: string): Promise<TwitchChannelState | null> {
  const state = await getChannelsState([login]);
  const channel = state[login.toLowerCase()];
  if (!channel || !channel.exists) return null;
  return channel;
}

/** Extrait l'identifiant de chaîne d'une URL Twitch ou d'un pseudo brut. */
export function parseTwitchLogin(input: string): string | null {
  const value = input.trim();
  if (!value) return null;

  // Le segment doit être complet : sinon « twitch.tv/zzz-bidon » donnerait
  // « zzz », une chaîne qui existe peut-être, et on lierait la mauvaise.
  const fromUrl = /twitch\.tv\/([A-Za-z0-9_]{2,25})(?:[/?#]|$)/i.exec(value);
  const raw = fromUrl ? fromUrl[1] : value;

  if (!/^[A-Za-z0-9_]{2,25}$/.test(raw)) return null;
  return raw.toLowerCase();
}
