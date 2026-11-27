/**
 * Rapprochement des ludothèques Steam / GOG / Epic.
 *
 * Steam, GOG et Epic n'ont aucun identifiant commun : le seul pont est le
 * titre. On normalise donc (minuscules, accents, ponctuation) et on retire les
 * suffixes d'édition, sinon « Cyberpunk 2077 » et « Cyberpunk 2077: Ultimate
 * Edition » compteraient deux fois.
 *
 * Ce module est PARTAGÉ par le profil (sa propre ludothèque) et la fiche d'un
 * membre : les deux pages doivent afficher exactement la même chose, sinon un
 * jeu apparaît sur l'une et pas sur l'autre.
 */

export const EDITION_WORDS = [
  'definitive edition',
  'game of the year edition',
  'goty edition',
  'ultimate edition',
  'deluxe edition',
  'complete edition',
  'enhanced edition',
  'remastered',
  'director s cut',
  'special edition',
  'legendary edition',
  'gold edition',
  'classic edition',
];

export function titleKey(name: string): string {
  let key = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[™®©]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  for (const suffix of EDITION_WORDS) {
    key = key.replace(new RegExp(`\\b${suffix}\\b`, 'g'), ' ');
  }
  return key.replace(/\s+/g, ' ').trim();
}

/** Jeu venu de GOG ou Epic (`/api/external-accounts?all=1`). */
export interface ExternalLibGame {
  platform: string;
  name: string;
  minutes: number;
  imageUrl: string | null;
  displayName?: string | null;
}

/** Champs minimums qu'une entrée de ludothèque doit avoir. */
export interface MergeableGame {
  appid: number | null;
  name: string;
  headerImage: string | null;
  genres: string[];
  source?: string;
  enriched: boolean;
  playtime: number;
  playtime2Weeks: number;
  platforms?: string[];
  external?: { platform: string; accountName: string | null; minutes: number }[];
}

/**
 * Fusionne les jeux Steam (déjà chargés) avec ceux de GOG / Epic.
 *
 * Un jeu présent sur plusieurs plateformes n'apparaît qu'une fois et porte les
 * badges correspondants. Le temps de jeu Steam reste prioritaire ; s'il est
 * nul, on prend celui d'Epic (seule plateforme qui en publie).
 *
 * `makeExternal` construit l'entrée complète pour un jeu qui n'existe que sur
 * GOG / Epic : chaque page a ses propres champs annexes (prix, notes…).
 */
export function mergeLibraries<T extends MergeableGame>(
  steam: T[],
  external: ExternalLibGame[],
  makeExternal: (ext: ExternalLibGame) => T,
): T[] {
  const merged = new Map<string, T>();

  for (const game of steam) {
    merged.set(titleKey(game.name), {
      ...game,
      platforms: ['steam'],
      external: [],
    });
  }

  for (const ext of external) {
    const key = titleKey(ext.name);
    const existing = merged.get(key);

    if (existing) {
      if (!existing.platforms) existing.platforms = ['steam'];
      if (!existing.platforms.includes(ext.platform)) existing.platforms.push(ext.platform);
      existing.external = existing.external ?? [];
      existing.external.push({
        platform: ext.platform,
        accountName: ext.displayName ?? null,
        minutes: ext.minutes,
      });
      // Une jaquette manquante est complétée par celle de l'autre plateforme.
      if (!existing.headerImage && ext.imageUrl) existing.headerImage = ext.imageUrl;
      // Aucune heure côté Steam : on affiche celle d'Epic.
      if (existing.playtime === 0 && ext.minutes > 0) existing.playtime = ext.minutes;
      continue;
    }

    merged.set(key, makeExternal(ext));
  }

  return [...merged.values()];
}
