const JSON_HEADERS = { 'Content-Type': 'application/json' };

async function handle<T>(p: Promise<Response>): Promise<T> {
  const res = await p;

  if (res.status === 401) {
    // Session expirée : on n'insiste pas, le header affichera le bouton Steam.
    throw new ApiError(401, 'Session expirée — reconnecte-toi avec Steam.');
  }

  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    throw new ApiError(res.status, data?.error ?? `Erreur HTTP ${res.status}`, data);
  }
  return data as T;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public data?: any,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function apiGet<T>(url: string, params?: Record<string, any>): Promise<T> {
  const qs = params
    ? '?' + new URLSearchParams(
        Object.entries(params)
          .filter(([, v]) => v !== undefined && v !== null && v !== '')
          .map(([k, v]) => [k, String(v)]),
      ).toString()
    : '';
  return handle<T>(fetch(url + qs, { credentials: 'same-origin' }));
}

export function apiPost<T>(url: string, body?: any): Promise<T> {
  return handle<T>(
    fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: JSON_HEADERS,
      body: body ? JSON.stringify(body) : undefined,
    }),
  );
}

/** DELETE avec corps JSON (les identifiants passent mieux dans le corps). */
export function apiDelete<T>(url: string, body?: any): Promise<T> {
  return handle<T>(
    fetch(url, {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: JSON_HEADERS,
      body: body ? JSON.stringify(body) : undefined,
    }),
  );
}

/* ── Formatage ── */

/** Minutes → « 12 h 30 » ou « 45 min ». */
export function formatPlaytime(minutes: number): string {
  if (!minutes) return '0 h';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  if (h < 100 && m > 0) return `${h} h ${String(m).padStart(2, '0')}`;
  return `${h} h`;
}

export function steamStoreUrl(appid: number) {
  return `https://store.steampowered.com/app/${appid}/`;
}

/**
 * Jaquette d'un jeu, déduite de son appid.
 *
 * L'URL est un motif stable chez Steam : inutile d'attendre l'enrichissement
 * (qui ne remplit header_image qu'après un appel au Store). Ça évite une
 * liste de jeux sans images au premier sync.
 *
 * Tous les jeux n'ont pas de jaquette : l'appelant doit gérer l'échec.
 */
export function steamHeaderUrl(appid: number) {
  return `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`;
}

/**
 * Recherche GG.deals pour un jeu.
 * On passe par la recherche (faute de slug fiable) : le nom suffit dans
 * l'immense majorité des cas.
 */
export function ggDealsUrl(name: string) {
  return `https://gg.deals/search/?q=${encodeURIComponent(name)}`;
}

/** Libellé qualitatif d'une note d'avis Steam (pourcentage positif). */
export function reviewLabel(score: number | null | undefined): {
  text: string;
  tone: 'ok' | 'warn' | 'danger' | 'muted';
} {
  if (score == null) return { text: 'Avis inconnus', tone: 'muted' };
  if (score >= 85) return { text: 'Très positive', tone: 'ok' };
  if (score >= 70) return { text: 'Positive', tone: 'ok' };
  if (score >= 50) return { text: 'Mitigée', tone: 'warn' };
  return { text: 'Négative', tone: 'danger' };
}

/** Formate un prix stocké en centimes. */
export function formatPrice(priceCents: number, currency = 'EUR'): string {
  try {
    return new Intl.NumberFormat('fr-FR', {
      style: 'currency',
      currency,
    }).format(priceCents / 100);
  } catch {
    return `${(priceCents / 100).toFixed(2)} €`;
  }
}

/** Masque une image dont le chargement a échoué (jaquette absente). */
export function hideBrokenImage(event: Event) {
  const img = event.target as HTMLImageElement;
  img.style.visibility = 'hidden';
}
