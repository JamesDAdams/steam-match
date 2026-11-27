import { apiGet } from './api';

/**
 * Garde du routeur : lit l'état d'authentification une seule fois.
 *
 * Le contrôle ici est purement cosmétique (éviter d'afficher une page qui
 * n'affichera que des 403). La sécurité réelle est dans l'API : chaque route
 * appelle requireAccess() ou requireAdmin().
 */

let cached: MeStateLike | null = null;
let cachedAt = 0;
const TTL_MS = 5000;

interface MeStateLike {
  authenticated: boolean;
  allowed?: boolean;
  isAdmin?: boolean;
  features?: {
    recommendations?: boolean;
    recap?: boolean;
    recapPublic?: boolean;
    releasesPublic?: boolean;
  };
}

export async function refreshAuth(): Promise<MeStateLike> {
  // Petit cache : évite 3 appels réseau lors d'une navigation rapide.
  if (cached && Date.now() - cachedAt < TTL_MS) return cached;

  try {
    const data = await apiGet<{ ok: boolean } & MeStateLike>('/api/me');
    cached = {
      authenticated: Boolean(data.authenticated),
      allowed: data.allowed,
      isAdmin: data.isAdmin,
      features: (data as any).features ?? {},
    };
  } catch {
    cached = { authenticated: false };
  }
  cachedAt = Date.now();
  return cached;
}

/** À appeler après un login/logout pour ne pas servir un état périmé. */
export function invalidateAuthCache() {
  cached = null;
  cachedAt = 0;
}
