import { getSettings } from './settings.ts';

/**
 * Drapeaux d'affichage lus depuis les réglages admin.
 *
 * POURQUOI ICI : la page « Recommandations » est en chantier et masquée par
 * défaut. Plutôt que de dupliquer la lecture des réglages dans chaque handler,
 * on centralise (et on tolère une erreur de base : on masque alors la page
 * plutôt que de casser /api/me).
 */
/**
 * Le récap' du groupe est-il publié ? (page et image masquées si désactivé.)
 */
export async function recapEnabled(): Promise<boolean> {
  try {
    const settings = await getSettings();
    return settings.recapEnabled;
  } catch {
    return false;
  }
}

/**
 * La page du récap' est-elle consultable SANS connexion ?
 *
 * Vrai seulement si le récap' existe ET que l'admin a ouvert la page au
 * public. Sert au menu : un visiteur non connecté ne doit voir le lien que
 * dans ce cas.
 */
export async function recapPublicPage(): Promise<boolean> {
  try {
    const settings = await getSettings();
    return settings.recapEnabled && settings.recapPublicPage;
  } catch {
    return false;
  }
}

export async function recommendationsEnabled(): Promise<boolean> {
  try {
    const settings = await getSettings();
    return settings.recommendationsEnabled;
  } catch {
    return false;
  }
}
