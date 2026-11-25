/**
 * Métadonnées des jeux (nom, genres, tags).
 *
 * POURQUOI PAS L'API DU STORE STEAM :
 * store.steampowered.com/api/appdetails est lente (~250 ms), limitée à
 * ~200 requêtes / 5 min, et sans en-tête explicite. Pour enrichir des
 * centaines de jeux, ce n'est pas tenable.
 *
 * On interroge donc SteamSpy en premier : sans clé, rapide, et il renvoie
 * le nom, les genres et les tags communautaires en un seul appel. Le Store
 * Steam reste en secours pour les appids absents de SteamSpy.
 */

const STEAMSPY = 'https://steamspy.com/api.php';
const STORE = 'https://store.steampowered.com/api/appdetails';

export interface GameMetadata {
  name: string;
  genres: string[];
  tags: string[];
  shortDescription: string | null;
  /** Origine des données, utile pour diagnostiquer. */
  source: 'steamspy' | 'store';
}

interface SteamSpyDetails {
  name?: string;
  genre?: string;
  tags?: Record<string, number> | string[];
}

/** SteamSpy renvoie parfois « Action, Indie, Simulation ». */
function splitGenres(genre?: string): string[] {
  if (!genre) return [];
  return genre
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean);
}

/** Les tags SteamSpy sont un objet { tag: votes } ; on garde les plus votés. */
function topTags(tags?: Record<string, number> | string[]): string[] {
  if (!tags) return [];
  if (Array.isArray(tags)) return tags.slice(0, 12);
  return Object.entries(tags)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([name]) => name);
}

async function fromSteamSpy(appid: number): Promise<GameMetadata | null> {
  try {
    const res = await fetch(`${STEAMSPY}?request=appdetails&appid=${appid}`, {
      headers: {
        // SteamSpy renvoie {} sans User-Agent identifiable.
        'User-Agent': 'BastionDesGamers/1.0',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;

    const d = (await res.json()) as SteamSpyDetails;
    // SteamSpy renvoie un objet vide pour un appid inconnu.
    if (!d?.name) return null;

    return {
      name: d.name,
      genres: splitGenres(d.genre),
      tags: topTags(d.tags),
      shortDescription: null,
      source: 'steamspy',
    };
  } catch {
    return null;
  }
}

async function fromSteamStore(appid: number): Promise<GameMetadata | null> {
  try {
    const res = await fetch(
      `${STORE}?appids=${appid}&l=french&filters=genres,basic,categories,short_description`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (res.status === 429 || !res.ok) return null;

    const json = (await res.json()) as Record<
      string,
      { success?: boolean; data?: any }
    >;
    const entry = json[String(appid)];
    if (!entry?.success || !entry.data) return null;

    const d = entry.data;
    return {
      name: d.name ?? `App ${appid}`,
      genres: (d.genres ?? []).map((g: any) => g.description).filter(Boolean),
      tags: (d.categories ?? []).map((c: any) => c.description).filter(Boolean),
      shortDescription: d.short_description ?? null,
      source: 'store',
    };
  } catch {
    return null;
  }
}

/**
 * Récupère les métadonnées d'un jeu.
 * SteamSpy d'abord (rapide, sans quota serré), Store Steam en secours.
 */
export async function fetchMetadata(appid: number): Promise<GameMetadata | null> {
  return (await fromSteamSpy(appid)) ?? (await fromSteamStore(appid));
}
