/**
 * Distinguer un JEU d'un LOGICIEL.
 *
 * POURQUOI CE N'EST PAS TRIVIAL : sur Steam, un utilitaire comme Lossless
 * Scaling est déclaré `type: "game"` — il n'y a donc pas de drapeau fiable.
 * Le seul signal systématique est le genre : « Utilities » côté SteamSpy
 * (anglais), « Utilitaires » côté Store (français, puisque l'enrichissement
 * demande `l=french`).
 *
 * RÈGLE RETENUE : c'est un logiciel dès qu'il porte un genre d'utilitaire ET
 * aucun genre de jeu. Cette seconde condition évite de masquer des jeux qui
 * touchent à la création — RPG Maker est classé « Design & Illustration »
 * mais aussi « RPG », il reste donc un jeu.
 */

/** Genres qui trahissent un logiciel (anglais SteamSpy + français Store). */
const SOFTWARE_GENRES = new Set([
  'utilities',
  'utilitaires',
  'software training',
  'formation logicielle',
  'animation & modeling',
  'animation et modélisation',
  'audio production',
  'production audio',
  'design & illustration',
  'conception et illustration',
  'photo editing',
  'édition de photos',
  'video production',
  'production vidéo',
  'web publishing',
  'édition web',
  'accounting',
  'comptabilité',
  'education',
  'éducation',
]);

/** Genres qui prouvent qu'on a affaire à un jeu, quoi qu'il arrive. */
const GAME_GENRES = new Set([
  'action',
  'adventure',
  'aventure',
  'rpg',
  'strategy',
  'stratégie',
  'simulation',
  'casual',
  'occasionnel',
  'indie',
  'indépendant',
  'racing',
  'course',
  'sports',
  'sport',
  'massively multiplayer',
  'massivement multijoueur',
  'violent',
  'gore',
  'sexual content',
  'contenu sexuel',
]);

function norm(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

const SOFTWARE_NORM = new Set([...SOFTWARE_GENRES].map(norm));
const GAME_NORM = new Set([...GAME_GENRES].map(norm));

export function isSoftwareApp(
  genres: string[] | null | undefined,
  type?: string | null,
): boolean {
  if (type && type.toLowerCase() === 'software') return true;
  if (!genres || genres.length === 0) return false;

  const normalised = genres.map(norm);
  const hasSoftware = normalised.some((g) => SOFTWARE_NORM.has(g));
  if (!hasSoftware) return false;

  const hasGame = normalised.some((g) => GAME_NORM.has(g));
  return !hasGame;
}
