/**
 * Dates « métier », toujours exprimées dans le fuseau de Paris.
 *
 * POURQUOI CE FICHIER : le serveur tourne en UTC (Netlify), les membres vivent
 * en France. Une fenêtre « 7 derniers jours » calculée en UTC décalerait les
 * journées de deux heures, et une image générée à 6 h du matin pourrait tomber
 * la veille. Tout ce qui est daté dans l'interface passe donc par ici.
 */

/** Jour courant au format YYYY-MM-DD, heure de Paris. */
export function todayInParis(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Heure courante (0-23) à Paris. */
export function hourInParis(now = new Date()): number {
  return Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Paris',
      hour: '2-digit',
      hour12: false,
    }).format(now),
  );
}

/** Décale un jour YYYY-MM-DD de `delta` jours (arithmétique UTC, sans dérive). */
export function shiftDay(day: string, delta: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const at = new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1) + delta * 86_400_000);
  return at.toISOString().slice(0, 10);
}

/** Nombre de jours entre deux jours YYYY-MM-DD (b - a). */
export function daysBetween(a: string, b: string): number {
  const toMs = (s: string) => {
    const [y, m, d] = s.split('-').map(Number);
    return Date.UTC(y, (m ?? 1) - 1, d ?? 1);
  };
  return Math.round((toMs(b) - toMs(a)) / 86_400_000);
}

/** « 26/11/2026 » — pour l'affichage, jamais pour le stockage. */
export function formatDay(day: string): string {
  const [y, m, d] = day.split('-');
  return `${d}/${m}/${y}`;
}

/** « 26 nov. » — format court utilisé dans l'image du récap'. */
export function formatDayShort(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const at = new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
  return new Intl.DateTimeFormat('fr-FR', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(at);
}
