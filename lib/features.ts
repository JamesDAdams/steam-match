import { getSettings } from './settings.ts';

/**
 * Drapeaux d'affichage lus depuis les réglages admin.
 *
 * POURQUOI ICI : la page « Recommandations » est en chantier et masquée par
 * défaut. Plutôt que de dupliquer la lecture des réglages dans chaque handler,
 * on centralise (et on tolère une erreur de base : on masque alors la page
 * plutôt que de casser /api/me).
 */
export async function recommendationsEnabled(): Promise<boolean> {
  try {
    const settings = await getSettings();
    return settings.recommendationsEnabled;
  } catch {
    return false;
  }
}
