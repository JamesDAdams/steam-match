import { getDb } from '../db/index.ts';
import { sql } from 'drizzle-orm';

/**
 * Calendrier des sorties du groupe.
 *
 * POURQUOI PAS LE « CALENDRIER PERSONNEL » DE STEAM :
 * `store.steampowered.com/personalcalendar` exige une session Steam (il répond
 * 302 vers la connexion). C'est une page personnalisée côté compte, comme la
 * bibliothèque familiale : aucun serveur ne peut la lire sans les cookies du
 * visiteur.
 *
 * On reconstitue donc l'équivalent avec ce qu'on possède déjà : les wishlists
 * des membres et la date de sortie de chaque jeu, récupérée du Store. C'est
 * même plus utile ici, puisque le calendrier est celui de tout le groupe.
 */

const MONTHS: Record<string, number> = {
  janv: 0,
  janvier: 0,
  fevr: 1,
  fevrier: 1,
  mars: 2,
  avr: 3,
  avril: 3,
  mai: 4,
  juin: 5,
  juil: 6,
  juillet: 6,
  aout: 7,
  sept: 8,
  septembre: 8,
  oct: 9,
  octobre: 9,
  nov: 10,
  novembre: 10,
  dec: 11,
  decembre: 11,
};

/** Normalise : minuscules, sans accents, sans points. */
function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\./g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface ParsedRelease {
  /** Jour de sortie (UTC), null si la date n'est pas connue précisément. */
  date: Date | null;
  /** Annoncé mais sans date ferme (« prochainement », année seule). */
  upcoming: boolean;
  /** Texte d'origine, à afficher tel quel si on ne sait pas mieux. */
  label: string;
}

/**
 * Analyse les dates du Store Steam en français : « 16 juil. 2020 »,
 * « 9 sept. 2026 », « 2027 », « Prochainement », « À déterminer ».
 */
export function parseReleaseDate(raw: string | null | undefined): ParsedRelease | null {
  if (!raw) return null;
  const label = raw.trim();
  if (!label) return null;

  const text = normalize(label);

  // Date complète : « 16 juillet 2020 ».
  const full = /^(\d{1,2}) ([a-z]+) (\d{4})$/.exec(text);
  if (full) {
    const day = Number(full[1]);
    const month = MONTHS[full[2]];
    const year = Number(full[3]);
    if (month !== undefined && day >= 1 && day <= 31) {
      return { date: new Date(Date.UTC(year, month, day)), upcoming: false, label };
    }
  }

  // Année seule : on la place au 1er janvier, sans prétendre connaître le jour.
  const yearOnly = /^(\d{4})$/.exec(text);
  if (yearOnly) {
    const year = Number(yearOnly[1]);
    return { date: new Date(Date.UTC(year, 0, 1)), upcoming: true, label };
  }

  // Trimestre : « q1 2027 ».
  const quarter = /^q([1-4]) (\d{4})$/.exec(text);
  if (quarter) {
    const q = Number(quarter[1]);
    const year = Number(quarter[2]);
    return { date: new Date(Date.UTC(year, (q - 1) * 3, 1)), upcoming: true, label };
  }

  if (/prochainement|bientot|coming soon|a venir|tba|a paraitre/.test(text)) {
    return { date: null, upcoming: true, label };
  }

  // « À déterminer », dates exotiques : on garde le libellé, sans date.
  return { date: null, upcoming: true, label };
}

/** Fenêtres affichées : prochains 30 jours, sorties des 90 derniers jours. */
const UPCOMING_DAYS = 30;
const RECENT_DAYS = 90;

export interface ReleaseEntry {
  appid: number;
  name: string;
  headerImage: string | null;
  releaseDate: string;
  /** ISO (YYYY-MM-DD) quand la date est connue. */
  dateIso: string | null;
  upcoming: boolean;
  daysUntil: number | null;
  wishCount: number;
  steamPrice: number | null;
  steamCurrency: string | null;
  steamDiscount: number | null;
  ownedBySomeone: boolean;
}

export interface ReleaseCalendar {
  /** Sorties dans les 30 prochains jours. */
  upcoming: ReleaseEntry[];
  /** Sorties des 90 derniers jours. */
  recent: ReleaseEntry[];
  /** Datées mais au-delà de 30 jours. */
  later: ReleaseEntry[];
  /** Annoncées sans date ferme. */
  undated: ReleaseEntry[];
}

export async function getReleaseCalendar(): Promise<ReleaseCalendar> {
  const db = getDb();

  const rows = await db.execute(sql`
    SELECT c.appid,
           c.name,
           c.header_image,
           c.release_date,
           c.steam_price,
           c.steam_currency,
           c.steam_discount,
           count(DISTINCT w.steamid)::int AS wish_count,
           EXISTS (SELECT 1 FROM owned_games o WHERE o.appid = c.appid) AS owned_by_someone
    FROM wishlist_items w
    JOIN game_cache c ON c.appid = w.appid
    WHERE c.release_date IS NOT NULL
      AND c.is_software = false
    GROUP BY c.appid, c.name, c.header_image, c.release_date,
             c.steam_price, c.steam_currency, c.steam_discount
  `);

  const today = new Date();
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());

  const upcoming: ReleaseEntry[] = [];
  const recent: ReleaseEntry[] = [];
  const later: ReleaseEntry[] = [];
  const undated: ReleaseEntry[] = [];

  for (const raw of rows.rows ?? rows) {
    const parsed = parseReleaseDate(raw.release_date as string);
    if (!parsed) continue;

    const entry: ReleaseEntry = {
      appid: Number(raw.appid),
      name: String(raw.name),
      // Repli déterministe : la jaquette d'un jeu Steam est toujours au même
      // endroit sur le CDN, inutile d'afficher une carte vide.
      headerImage:
        (raw.header_image as string) ??
        `https://cdn.cloudflare.steamstatic.com/steam/apps/${Number(raw.appid)}/header.jpg`,
      releaseDate: parsed.label,
      dateIso: parsed.date ? parsed.date.toISOString().slice(0, 10) : null,
      upcoming: parsed.upcoming,
      daysUntil: parsed.date
        ? Math.round((parsed.date.getTime() - todayUtc) / 86_400_000)
        : null,
      wishCount: Number(raw.wish_count ?? 0),
      steamPrice: raw.steam_price === null ? null : Number(raw.steam_price),
      steamCurrency: (raw.steam_currency as string) ?? null,
      steamDiscount: raw.steam_discount === null ? null : Number(raw.steam_discount),
      ownedBySomeone: Boolean(raw.owned_by_someone),
    };

    if (parsed.date) {
      const diff = entry.daysUntil ?? 0;
      if (diff > 0 && diff <= UPCOMING_DAYS) {
        upcoming.push(entry);
      } else if (diff > UPCOMING_DAYS) {
        later.push(entry);
      } else if (diff >= -RECENT_DAYS) {
        recent.push(entry);
      }
      // Plus vieux que 90 jours : on ignore (ce n'est plus une sortie).
    } else if (parsed.upcoming) {
      undated.push(entry);
    }
  }

  upcoming.sort(
    (a, b) =>
      (a.daysUntil ?? Number.MAX_SAFE_INTEGER) - (b.daysUntil ?? Number.MAX_SAFE_INTEGER) ||
      b.wishCount - a.wishCount,
  );
  later.sort(
    (a, b) =>
      (a.daysUntil ?? Number.MAX_SAFE_INTEGER) - (b.daysUntil ?? Number.MAX_SAFE_INTEGER) ||
      b.wishCount - a.wishCount,
  );
  undated.sort((a, b) => b.wishCount - a.wishCount || a.name.localeCompare(b.name, 'fr'));
  recent.sort((a, b) => (b.daysUntil ?? 0) - (a.daysUntil ?? 0));

  return { upcoming, recent, later, undated };
}
