import { getDb } from '../db/index.ts';
import { recapImages, gameCache } from '../db/schema.ts';
import { eq, inArray, sql } from 'drizzle-orm';
import { getSettings, updateSettings } from './settings.ts';
import { daysBetween, formatDay, formatDayShort, shiftDay, todayInParis } from './dates.ts';

/**
 * Récap' du groupe : qui a joué quoi ces N derniers jours, en une image.
 *
 * D'OÙ VIENNENT LES CHIFFRES
 * --------------------------
 * Steam n'expose que deux durées : `playtime_forever` (cumul depuis toujours)
 * et `playtime_2weeks` (14 derniers jours, jamais 7). « Les plus joués des
 * 7 derniers jours » n'est donc pas une donnée que Steam sait donner.
 *
 * D'où `playtime_daily` : à chaque synchronisation on relève le cumul du jour.
 * La différence entre le premier et le dernier relevé de la fenêtre donne le
 * temps réellement joué. Tant que l'historique est trop court (premiers jours
 * après la mise en service), on retombe sur `playtime_2weeks` ramené au nombre
 * de jours demandé, et l'image le dit explicitement.
 *
 * « Jeux lancés », lui, est exact immédiatement : `rtime_last_played` est
 * rétroactif et fourni par Steam à chaque synchronisation.
 */

export interface RecapPlayer {
  name: string;
  minutes: number;
}

export interface RecapGame {
  appid: number;
  name: string;
  headerImage: string | null;
  /** Minutes jouées sur la fenêtre (0 pour un jeu seulement lancé). */
  minutes: number;
  /** Dernier lancement, ISO (null si inconnu). */
  lastPlayedAt: string | null;
  players: RecapPlayer[];
}

export interface RecapStats {
  days: number;
  /** 'measured' = relevés quotidiens ; 'estimated' = extrapolé des 14 jours. */
  mode: 'measured' | 'estimated';
  windowStart: string;
  windowEnd: string;
  /** Jours réellement couverts par l'historique (peut être < days). */
  coverageDays: number;
  /** Première journée d'historique connue, si elle existe. */
  historyStart: string | null;
  generatedAt: string;
  top: RecapGame[];
  launched: RecapGame[];
  totals: {
    minutes: number;
    games: number;
    players: number;
  };
}

const MAX_TOP = 10;
const IN_IMAGE_TOP = 5;
const IN_IMAGE_LAUNCHED = 18;

/* ─────────────────────────── Agrégation ─────────────────────────── */

interface AccountRow {
  steamid: string;
  discord_id: string;
  name: string;
}

/**
 * Comptes Steam rattachés à un membre : le compte principal et ses comptes
 * secondaires. Les comptes FAMILLE sont exclus : leur temps de jeu appartient
 * à quelqu'un d'autre, et l'agréger gonflerait les chiffres du membre.
 */
async function loadCountedAccounts(): Promise<Map<string, { discordId: string; name: string }>> {
  const db = getDb();

  const primary = (await db.execute(sql`
    SELECT l.steamid AS steamid,
           l.discord_id AS discord_id,
           COALESCE(du.global_name, du.username, l.discord_id) AS name
    FROM steam_links l
    LEFT JOIN discord_users du ON du.discord_id = l.discord_id
  `)) as unknown as { rows?: AccountRow[] };

  const secondary = (await db.execute(sql`
    SELECT sa.steamid AS steamid,
           l.discord_id AS discord_id,
           COALESCE(du.global_name, du.username, l.discord_id) AS name
    FROM steam_accounts sa
    JOIN steam_links l ON l.steamid = sa.owner_steamid
    LEFT JOIN discord_users du ON du.discord_id = l.discord_id
    WHERE sa.kind = 'secondary'
  `)) as unknown as { rows?: AccountRow[] };

  const out = new Map<string, { discordId: string; name: string }>();
  for (const row of [...(primary.rows ?? []), ...(secondary.rows ?? [])]) {
    out.set(String(row.steamid), { discordId: String(row.discord_id), name: row.name });
  }
  return out;
}

interface SnapshotRow {
  steamid: string;
  appid: number;
  minutes_min: number;
  minutes_max: number;
  day: string;
}

/** Agrège les relevés quotidiens par (compte, jeu) sur la fenêtre. */
function aggregateSnapshots(
  rows: SnapshotRow[],
): Map<string, { firstMin: number; lastMax: number; firstDay: string; lastDay: string }> {
  const perPair = new Map<
    string,
    { firstMin: number; lastMax: number; firstDay: string; lastDay: string }
  >();

  for (const r of rows) {
    const appid = Number(r.appid);
    const key = `${r.steamid}|${appid}`;
    const min = Number(r.minutes_min ?? 0);
    const max = Number(r.minutes_max ?? 0);
    const day = String(r.day);

    const cur = perPair.get(key);
    if (!cur) {
      perPair.set(key, { firstMin: min, lastMax: max, firstDay: day, lastDay: day });
      continue;
    }
    // Les jours sont triables tels quels (YYYY-MM-DD).
    if (day < cur.firstDay) {
      cur.firstDay = day;
      cur.firstMin = min;
    }
    if (day > cur.lastDay) {
      cur.lastDay = day;
      cur.lastMax = max;
    }
  }
  return perPair;
}

interface Bump {
  minutesByMember: Map<string, number>;
  launchByMember: Map<string, number>;
}

function bumpFor(map: Map<number, Bump>, appid: number): Bump {
  let cur = map.get(appid);
  if (!cur) {
    cur = { minutesByMember: new Map(), launchByMember: new Map() };
    map.set(appid, cur);
  }
  return cur;
}

export async function getRecapStats(daysInput?: number): Promise<RecapStats> {
  const db = getDb();
  const settings = await getSettings();
  const days = Math.max(
    1,
    Math.min(30, Math.round(daysInput ?? settings.recapDays ?? 7)),
  );

  const windowEnd = todayInParis();
  const windowStart = shiftDay(windowEnd, -(days - 1));

  const accounts = await loadCountedAccounts();
  const appMap = new Map<number, Bump>();

  // ── Relevés quotidiens ────────────────────────────────────────────
  const snapRaw = (await db.execute(sql`
    SELECT steamid, appid, minutes_min, minutes_max, day::text AS day
    FROM playtime_daily
    WHERE day >= CAST(${windowStart} AS date) AND day <= CAST(${windowEnd} AS date)
  `)) as unknown as { rows?: SnapshotRow[] };
  const snapshots = snapRaw.rows ?? [];

  const historyRaw = (await db.execute(sql`
    SELECT MIN(day)::text AS first_day FROM playtime_daily
  `)) as unknown as { rows?: { first_day: string | null }[] };
  const historyStart = historyRaw.rows?.[0]?.first_day ?? null;

  // ── Jeux lancés / cumul 14 jours (par membre) ─────────────────────
  const ownedRaw = (await db.execute(sql`
    SELECT o.steamid AS owner_steamid,
           o.appid,
           COALESCE(o.playtime_2weeks, 0) AS p2w,
           o.last_played_at
    FROM owned_games o
    WHERE o.source <> 'family'
  `)) as unknown as {
    rows?: {
      owner_steamid: string;
      appid: number;
      p2w: number;
      last_played_at: string | null;
    }[];
  };
  const ownedRows = ownedRaw.rows ?? [];

  const windowStartMs = Date.parse(`${windowStart}T00:00:00Z`) - 3 * 3600_000;
  const measured = snapshots.length > 0;

  if (measured) {
    const pairs = aggregateSnapshots(snapshots);
    for (const [key, agg] of pairs) {
      const [steamid, appidRaw] = key.split('|');
      const appid = Number(appidRaw);
      const account = accounts.get(steamid);
      if (!account) continue;

      const delta = agg.lastMax - agg.firstMin;
      if (delta <= 0) continue;

      const bump = bumpFor(appMap, appid);
      bump.minutesByMember.set(
        account.discordId,
        (bump.minutesByMember.get(account.discordId) ?? 0) + delta,
      );
    }
  } else {
    // Historique absent : on extrapole les 14 jours de Steam sur la fenêtre.
    const factor = days / 14;
    for (const row of ownedRows) {
      const p2w = Number(row.p2w ?? 0);
      if (p2w <= 0) continue;
      const account = accounts.get(String(row.owner_steamid));
      if (!account) continue;

      const minutes = Math.max(1, Math.round(p2w * factor));
      const bump = bumpFor(appMap, Number(row.appid));
      bump.minutesByMember.set(
        account.discordId,
        (bump.minutesByMember.get(account.discordId) ?? 0) + minutes,
      );
    }
  }

  // Lancements : valables dans les deux modes (rtime_last_played est exact).
  for (const row of ownedRows) {
    const account = accounts.get(String(row.owner_steamid));
    if (!account) continue;

    const last = row.last_played_at ? Date.parse(row.last_played_at) : NaN;
    const launchedInWindow = Number.isFinite(last) && last >= windowStartMs;
    const p2w = Number(row.p2w ?? 0);

    if (!launchedInWindow && !(p2w > 0 && !Number.isFinite(last))) continue;

    const bump = bumpFor(appMap, Number(row.appid));
    const prev = bump.launchByMember.get(account.discordId) ?? 0;
    if (Number.isFinite(last) && last > prev) bump.launchByMember.set(account.discordId, last);
    else if (!bump.launchByMember.has(account.discordId)) bump.launchByMember.set(account.discordId, 0);
  }

  // ── Métadonnées des jeux concernés ────────────────────────────────
  const appids = [...appMap.keys()];
  const cache = appids.length
    ? await db
        .select({
          appid: gameCache.appid,
          name: gameCache.name,
          headerImage: gameCache.headerImage,
        })
        .from(gameCache)
        .where(inArray(gameCache.appid, appids))
    : [];
  const meta = new Map(cache.map((c) => [c.appid, c]));

  const namesByDiscord = new Map<string, string>();
  for (const value of accounts.values()) namesByDiscord.set(value.discordId, value.name);

  const toGame = (appid: number): RecapGame => {
    const bump = appMap.get(appid)!;
    const m = meta.get(appid);

    const players: RecapPlayer[] = [...bump.minutesByMember.entries()]
      .map(([discordId, minutes]) => ({
        name: namesByDiscord.get(discordId) ?? 'Membre',
        minutes,
      }))
      .filter((p) => p.minutes > 0)
      .sort((a, b) => b.minutes - a.minutes);

    const launchTimes = [...bump.launchByMember.values()].filter((t) => t > 0);
    const lastPlayed = launchTimes.length ? new Date(Math.max(...launchTimes)).toISOString() : null;

    return {
      appid,
      name: m?.name ?? `App ${appid}`,
      headerImage: m?.headerImage ?? null,
      minutes: [...bump.minutesByMember.values()].reduce((a, b) => a + b, 0),
      lastPlayedAt: lastPlayed,
      players,
    };
  };

  const all = appids.map(toGame);
  const played = all.filter((g) => g.minutes > 0);
  const launched = all.filter((g) => g.minutes > 0 || g.lastPlayedAt !== null);

  played.sort((a, b) => b.minutes - a.minutes || a.name.localeCompare(b.name, 'fr'));
  launched.sort((a, b) => b.minutes - a.minutes || a.name.localeCompare(b.name, 'fr'));

  const playerSet = new Set<string>();
  for (const g of launched) for (const p of g.players) playerSet.add(p.name);

  const totalMinutes = played.reduce((sum, g) => sum + g.minutes, 0);

  const coverageDays = historyStart
    ? Math.max(1, Math.min(days, daysBetween(maxDay(historyStart, windowStart), windowEnd) + 1))
    : 0;

  return {
    days,
    mode: measured ? 'measured' : 'estimated',
    windowStart,
    windowEnd,
    coverageDays,
    historyStart,
    generatedAt: new Date().toISOString(),
    top: played.slice(0, MAX_TOP),
    launched,
    totals: {
      minutes: totalMinutes,
      games: launched.length,
      players: playerSet.size,
    },
  };
}

function maxDay(a: string, b: string): string {
  return a > b ? a : b;
}

/* ─────────────────────────── Rendu SVG ─────────────────────────── */

const W = 1200;
const PAD = 56;

const C = {
  bg: '#0f1116',
  panel: '#171a21',
  panelAlt: '#1b1f27',
  line: '#262b35',
  text: '#e7e9ee',
  muted: '#9aa3b2',
  gold: '#d4af37',
  goldSoft: '#3a2f12',
};

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** « 3 joueurs » / « 1 joueur » — sans le « (s) » qui alourdit l'image. */
function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** 125 → « 2 h 05 », 45 → « 45 min ». */
export function formatMinutes(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest >= 5 ? `${h} h ${String(rest).padStart(2, '0')}` : `${h} h`;
}

/** Télécharge une jaquette et la renvoie en data URI (null si indisponible). */
async function fetchCover(url: string | null | undefined): Promise<string | null> {
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;

    const type = res.headers.get('content-type') ?? 'image/jpeg';
    if (!type.startsWith('image/')) return null;

    const buf = Buffer.from(await res.arrayBuffer());
    // Une jaquette Steam fait ~40 Ko ; au-delà, l'image publiée devient lourde.
    if (buf.byteLength > 400_000) return null;

    return `data:${type.split(';')[0]};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

export function renderRecapSvg(
  stats: RecapStats,
  covers: Map<number, string>,
): string {
  const top = stats.top.slice(0, IN_IMAGE_TOP);
  const others = stats.launched.filter((g) => !top.some((t) => t.appid === g.appid));
  const shownOthers = others.slice(0, IN_IMAGE_LAUNCHED);
  const restCount = stats.launched.length - top.length - shownOthers.length;

  const headerH = 200;
  const sectionATitleH = 74;
  const rowH = 116;
  const sectionBH = 74;
  const cellH = 46;
  const cols = 3;
  const rowsB = Math.max(1, Math.ceil(shownOthers.length / cols));
  const footerH = 96;

  const height =
    headerH + sectionATitleH + Math.max(1, top.length) * rowH + sectionBH + rowsB * cellH + 40 + footerH;

  const endYear = stats.windowEnd.slice(0, 4);
  const period = `${formatDayShort(stats.windowStart)} → ${formatDayShort(stats.windowEnd)} ${endYear}`;
  const genDate = new Date(stats.generatedAt);
  const genLabel = new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(genDate);

  const parts: string[] = [];

  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}" viewBox="0 0 ${W} ${height}" font-family="Inter, 'Helvetica Neue', Arial, sans-serif">`);
  parts.push(`<defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#11141b"/>
      <stop offset="55%" stop-color="#0f1116"/>
      <stop offset="100%" stop-color="#141019"/>
    </linearGradient>
    <linearGradient id="gold" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#e8c766"/>
      <stop offset="100%" stop-color="#b8892a"/>
    </linearGradient>
    <clipPath id="coverClip"><rect x="0" y="0" width="176" height="82" rx="8"/></clipPath>
  </defs>`);
  parts.push(`<rect width="${W}" height="${height}" fill="url(#bg)"/>`);
  parts.push(
    `<rect x="0" y="0" width="${W}" height="4" fill="url(#gold)" opacity="0.9"/>`,
  );

  /* ── En-tête ─────────────────────────────────────────────────── */
  parts.push(
    `<text x="${PAD}" y="74" fill="${C.gold}" font-size="15" letter-spacing="6" font-weight="700">LE BASTION DES GAMERS</text>`,
  );
  parts.push(
    `<text x="${PAD}" y="126" fill="${C.text}" font-size="42" font-weight="800">Récap’ des ${stats.days} derniers jours</text>`,
  );
  parts.push(
    `<text x="${PAD}" y="160" fill="${C.muted}" font-size="17">${esc(
      `${period} · ${plural(stats.totals.players, 'joueur')} · ${plural(
        stats.totals.games,
        'jeu lancé',
        'jeux lancés',
      )} · ${formatMinutes(stats.totals.minutes)} de jeu`,
    )}</text>`,
  );

  /* ── Section 1 : les plus joués ──────────────────────────────── */
  let y = headerH;
  parts.push(
    `<text x="${PAD}" y="${y + 30}" fill="${C.gold}" font-size="14" letter-spacing="3" font-weight="700">LES PLUS JOUÉS</text>`,
  );
  parts.push(
    `<line x1="${PAD}" y1="${y + 44}" x2="${W - PAD}" y2="${y + 44}" stroke="${C.line}" stroke-width="1"/>`,
  );
  y += sectionATitleH;

  if (top.length === 0) {
    parts.push(
      `<text x="${PAD}" y="${y + 40}" fill="${C.muted}" font-size="18">Aucune activité enregistrée sur la période.</text>`,
    );
    y += rowH;
  }

  top.forEach((game, i) => {
    const cover = covers.get(game.appid);
    const rowY = y + i * rowH;

    parts.push(
      `<rect x="${PAD}" y="${rowY}" width="${W - PAD * 2}" height="${rowH - 14}" rx="14" fill="${
        i % 2 === 0 ? C.panel : C.panelAlt
      }"/>`,
    );
    parts.push(
      `<text x="${PAD + 26}" y="${rowY + 74}" fill="${C.gold}" font-size="34" font-weight="800">${
        i + 1
      }</text>`,
    );

    const coverX = PAD + 74;
    if (cover) {
      // Le clip est défini en coordonnées locales (0,0) : sans le translate,
      // le rectangle de découpe s'applique à l'origine du document et rogne
      // entièrement l'image. C'est ce qui laissait les jaquettes invisibles.
      parts.push(
        `<g transform="translate(${coverX}, ${rowY + 14})" clip-path="url(#coverClip)">` +
          `<image x="0" y="0" width="176" height="82" preserveAspectRatio="xMidYMid slice" href="${cover}"/>` +
          `</g>`,
      );
    } else {
      parts.push(
        `<rect x="${coverX}" y="${rowY + 14}" width="176" height="82" rx="8" fill="${C.panelAlt}" stroke="${C.line}"/>`,
        `<text x="${coverX + 88}" y="${rowY + 64}" fill="${C.muted}" font-size="13" text-anchor="middle">sans jaquette</text>`,
      );
    }

    const textX = coverX + 200;
    parts.push(
      `<text x="${textX}" y="${rowY + 46}" fill="${C.text}" font-size="22" font-weight="700">${esc(
        truncate(game.name, 42),
      )}</text>`,
    );

    const playersLabel = game.players.length
      ? game.players
          .slice(0, 4)
          .map((p) => truncate(p.name, 20))
          .join(', ') + (game.players.length > 4 ? ` +${game.players.length - 4}` : '')
      : '—';
    parts.push(
      `<text x="${textX}" y="${rowY + 72}" fill="${C.muted}" font-size="14">${esc(playersLabel)}</text>`,
    );

    parts.push(
      `<text x="${W - PAD - 30}" y="${rowY + 52}" fill="${C.text}" font-size="26" font-weight="800" text-anchor="end">${formatMinutes(
        game.minutes,
      )}</text>`,
    );
  });

  /* ── Section 2 : tous les jeux lancés ────────────────────────── */
  y += Math.max(1, top.length) * rowH;
  parts.push(
    `<text x="${PAD}" y="${y + 30}" fill="${C.gold}" font-size="14" letter-spacing="3" font-weight="700">TOUS LES JEUX LANCÉS</text>`,
  );
  parts.push(
    `<line x1="${PAD}" y1="${y + 44}" x2="${W - PAD}" y2="${y + 44}" stroke="${C.line}" stroke-width="1"/>`,
  );
  y += sectionBH;

  if (shownOthers.length === 0) {
    parts.push(
      `<text x="${PAD}" y="${y + 30}" fill="${C.muted}" font-size="16">Rien de plus sur la période.</text>`,
    );
  }

  const colW = (W - PAD * 2) / cols;
  shownOthers.forEach((game, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const cx = PAD + col * colW;
    const cy = y + row * cellH;

    parts.push(
      `<circle cx="${cx + 6}" cy="${cy + 18}" r="3.5" fill="${C.gold}" opacity="0.85"/>`,
    );
    parts.push(
      `<text x="${cx + 20}" y="${cy + 23}" fill="${C.text}" font-size="15">${esc(
        truncate(game.name, 30),
      )}</text>`,
    );
    const label = game.minutes > 0 ? formatMinutes(game.minutes) : 'lancé';
    parts.push(
      `<text x="${cx + colW - 26}" y="${cy + 23}" fill="${C.muted}" font-size="14" text-anchor="end">${label}</text>`,
    );
  });

  if (restCount > 0) {
    parts.push(
      `<text x="${PAD}" y="${y + rowsB * cellH + 26}" fill="${C.muted}" font-size="14">+ ${restCount} autre(s) jeu(x) — voir la page Récap’</text>`,
    );
  }

  /* ── Pied de page ────────────────────────────────────────────── */
  const footY = height - 62;
  parts.push(
    `<line x1="${PAD}" y1="${footY - 16}" x2="${W - PAD}" y2="${footY - 16}" stroke="${C.line}" stroke-width="1"/>`,
  );

  let note = `Données Steam · calculé le ${genLabel}`;
  if (stats.mode === 'estimated') {
    note += ' · estimation (historique en cours de constitution)';
  } else if (stats.coverageDays > 0 && stats.coverageDays < stats.days) {
    note += ` · mesuré depuis le ${formatDay(stats.historyStart ?? stats.windowStart)}`;
  }
  parts.push(
    `<text x="${PAD}" y="${footY + 12}" fill="${C.muted}" font-size="13">${esc(note)}</text>`,
  );
  parts.push(
    `<text x="${W - PAD}" y="${footY + 12}" fill="${C.gold}" font-size="13" text-anchor="end">le-bastion-des-gamers.netlify.app</text>`,
  );

  parts.push('</svg>');
  return parts.join('\n');
}

/* ─────────────────────────── Génération ─────────────────────────── */

const ROW_ID = 'default';

export interface GenerateResult {
  stats: RecapStats;
  svg: string;
}

/**
 * Construit l'image du récap' et la stocke.
 *
 * On la stocke plutôt que de la recalculer à chaque visite : l'agrégation
 * coûte plusieurs requêtes et le téléchargement des jaquettes Steam, pour un
 * contenu qui ne change qu'une fois par jour.
 */
export async function generateRecapImage(daysInput?: number): Promise<GenerateResult> {
  const db = getDb();
  const stats = await getRecapStats(daysInput);

  const covers = new Map<number, string>();
  await Promise.all(
    stats.top.slice(0, IN_IMAGE_TOP).map(async (game) => {
      const uri = await fetchCover(game.headerImage);
      if (uri) covers.set(game.appid, uri);
    }),
  );

  const svg = renderRecapSvg(stats, covers);

  await db
    .insert(recapImages)
    .values({
      id: ROW_ID,
      svg,
      windowDays: stats.days,
      mode: stats.mode,
      stats,
      generatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: recapImages.id,
      set: {
        svg,
        windowDays: stats.days,
        mode: stats.mode,
        stats: sql`excluded.stats`,
        generatedAt: new Date(),
      },
    });

  await updateSettings({ lastRecapAt: new Date() });

  return { stats, svg };
}

export async function getStoredRecap(): Promise<{
  svg: string;
  windowDays: number;
  mode: string;
  stats: RecapStats | null;
  generatedAt: Date;
} | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(recapImages)
    .where(eq(recapImages.id, ROW_ID))
    .limit(1);

  if (!row) return null;
  return {
    svg: row.svg,
    windowDays: row.windowDays,
    mode: row.mode,
    stats: (row.stats as RecapStats | null) ?? null,
    generatedAt: row.generatedAt,
  };
}

/**
 * Génère l'image si le réglage l'autorise et si le délai est écoulé.
 *
 * Appelée par la tâche horaire : Netlify ne sait pas reprogrammer un cron à
 * chaud, donc on se réveille à chaque heure et on vérifie ici.
 */
export async function runRecapIfDue(
  now = new Date(),
): Promise<{ ran: boolean; reason?: string; stats?: RecapStats }> {
  const settings = await getSettings();

  if (!settings.recapEnabled) return { ran: false, reason: 'disabled' };

  const intervalMs = Math.max(1, settings.recapRefreshHours) * 3_600_000;
  const last = settings.lastRecapAt?.getTime() ?? 0;
  if (last > 0 && now.getTime() - last < intervalMs) {
    return { ran: false, reason: 'interval' };
  }

  // Fréquence quotidienne ou plus lente : on attend l'heure choisie (Paris),
  // sinon l'image se régénérerait à l'heure du déploiement.
  if (settings.recapRefreshHours >= 24) {
    const parisHour = Number(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Paris',
        hour: '2-digit',
        hour12: false,
      }).format(now),
    );
    if (parisHour < settings.recapHour) {
      return { ran: false, reason: 'before-hour' };
    }
  }

  const { stats } = await generateRecapImage();
  return { ran: true, stats };
}
