/**
 * Espacement des appels HTTP par hôte.
 *
 * POURQUOI :
 * l'enrichissement envoie plusieurs centaines de requêtes. Sans contrôle, il
 * déclenche des 429 (Steam) ou un blocage (CheapShark, qui demande explicitement
 * 1 requête/seconde), et le worker passe son temps à réessayer.
 *
 * Chaque hôte a donc un intervalle minimal entre deux départs. Le calcul est
 * synchrone (réservation du créneau) avant tout `await`, donc plusieurs appels
 * concurrents ne peuvent pas obtenir le même créneau.
 *
 * Ce n'est PAS un sémaphore : les requêtes peuvent être en vol simultanément,
 * elles sont seulement espacées. C'est exactement ce qu'attendent ces API.
 */

/** Intervalle minimal entre deux requêtes, par hôte (ms). */
const HOST_INTERVAL_MS: Record<string, number> = {
  // Store Steam : tolérant en rafale, mais limité sur la durée (~200/5 min).
  'store.steampowered.com': 350,
  // SteamSpy : aucune limite documentée, restons courtois.
  'steamspy.com': 150,
  // CheapShark demande 1 req/s ; un léger dépassement passe, pas plus.
  'www.cheapshark.com': 800,
  // GG.deals : optionnel, quota inconnu.
  'api.gg.deals': 700,
};

const DEFAULT_INTERVAL_MS = 120;

/** Prochain créneau libre par hôte (timestamp ms). */
const nextSlot = new Map<string, number>();

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/** `fetch` qui respecte l'intervalle minimal de son hôte. */
export async function rateLimitedFetch(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const host = hostOf(url);
  const interval = HOST_INTERVAL_MS[host] ?? DEFAULT_INTERVAL_MS;

  // Réservation ATOMIQUE du créneau : tout est calculé avant le premier await.
  const now = Date.now();
  const slot = Math.max(now, nextSlot.get(host) ?? 0);
  nextSlot.set(host, slot + interval);

  if (slot > now) await sleep(slot - now);

  return fetch(url, init);
}

/** Remet les compteurs à zéro (utile pour les tests). */
export function resetRateLimits() {
  nextSlot.clear();
}
