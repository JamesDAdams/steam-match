import { getDb } from '../db/index.ts';
import { gameCache, notificationPrefs, releaseNotifications, wishlistItems } from '../db/schema.ts';
import { sql } from 'drizzle-orm';
import { getSettings, updateSettings } from './settings.ts';
import { parseReleaseDate } from './releases.ts';
import { findGuildChannelByName, isBotConfigured, sendChannelMessage } from './discord-bot.ts';

/**
 * Rappels Discord : « ce jeu de ta wishlist sort aujourd'hui ».
 *
 * POURQUOI UN BATCH QUOTIDIEN :
 * une sortie ne se produit qu'une fois par jour, et un message par membre est
 * plus lisible qu'une rafale de notifications. Le batch tourne à l'heure
 * configurée dans l'admin (6 h par défaut).
 *
 * POURQUOI UNE TABLE DE TRACE :
 * la tâche peut être relancée (bouton admin, redémarrage, deux instances) :
 * la clé (jeu, membre, jour) garantit qu'aucune annonce n'est envoyée deux fois.
 */

export interface ReleaseNotificationReport {
  ok: boolean;
  /** Jour traité (YYYY-MM-DD). */
  day: string;
  /** Jeux du jour trouvés dans les wishlists. */
  games: number;
  /** Membres à prévenir. */
  members: number;
  /** Messages réellement envoyés. */
  sent: number;
  skipped?: string;
  errors: string[];
}

/** Jour courant au format YYYY-MM-DD (heure de Paris pour être cohérent). */
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

interface TodaysGame {
  appid: number;
  name: string;
  wishers: string[];
}

/**
 * Jeux de la wishlist du groupe qui sortent à la date donnée.
 * Les dates stockées sont en texte français : on les analyse avec le même
 * analyseur que le calendrier.
 */
export async function getGamesReleasingOn(day: string): Promise<TodaysGame[]> {
  const db = getDb();
  const rows = await db.execute(sql`
    SELECT c.appid, c.name, c.release_date,
           array_agg(DISTINCT w.steamid) AS wishers
    FROM wishlist_items w
    JOIN game_cache c ON c.appid = w.appid
    WHERE c.release_date IS NOT NULL
    GROUP BY c.appid, c.name, c.release_date
  `);

  return ((rows.rows ?? rows) as any[])
    .filter((r) => {
      const parsed = parseReleaseDate(r.release_date as string);
      if (!parsed?.date) return false;
      return parsed.date.toISOString().slice(0, 10) === day;
    })
    .map((r) => ({
      appid: Number(r.appid),
      name: String(r.name),
      wishers: (r.wishers ?? []) as string[],
    }));
}

/**
 * Envoie les rappels du jour.
 *
 * `force` court-circuite l'heure configurée (bouton « envoyer maintenant »),
 * mais jamais la déduplication.
 */
export async function runReleaseNotifications(
  opts: { force?: boolean; day?: string } = {},
): Promise<ReleaseNotificationReport> {
  const report: ReleaseNotificationReport = {
    ok: true,
    day: opts.day ?? todayInParis(),
    games: 0,
    members: 0,
    sent: 0,
    errors: [],
  };

  const settings = await getSettings();
  if (!settings.releaseNotifyEnabled && !opts.force) {
    return { ...report, skipped: 'disabled' };
  }
  if (!isBotConfigured()) {
    return { ...report, ok: false, skipped: 'bot-not-configured' };
  }

  const db = getDb();
  const games = await getGamesReleasingOn(report.day);
  report.games = games.length;
  if (games.length === 0) {
    await updateSettings({ lastReleaseNotifyAt: new Date() });
    return { ...report, skipped: 'no-release' };
  }

  // Salon cible : identifiant configuré, sinon salon nommé « games ».
  let channelId = settings.releaseChannelId ?? null;
  if (!channelId) {
    const found = await findGuildChannelByName('games');
    channelId = found?.id ?? null;
  }
  if (!channelId) {
    return {
      ...report,
      ok: false,
      skipped: 'no-channel',
      errors: ['Salon Discord introuvable : configure son identifiant dans l’admin.'],
    };
  }

  // Qui veut être prévenu, et pour quoi.
  const prefs = await db
    .select({ discordId: notificationPrefs.discordId })
    .from(notificationPrefs)
    .where(sql`${notificationPrefs.releaseReminders} = true`);
  const optedIn = new Set(prefs.map((p) => p.discordId));

  // steamid → discordId (les wishlists sont indexées par compte Steam).
  const links = await db.execute(sql`SELECT discord_id, steamid FROM steam_links`);
  const discordBySteam = new Map<string, string>(
    ((links.rows ?? links) as { discord_id: string; steamid: string }[]).map((l) => [
      l.steamid,
      l.discord_id,
    ]),
  );

  // Déjà envoyé ?
  const sentRows = await db.execute(sql`
    SELECT appid, discord_id FROM release_notifications WHERE release_date = ${report.day}
  `);
  const alreadySent = new Set(
    ((sentRows.rows ?? sentRows) as { appid: number; discord_id: string }[]).map(
      (r) => `${r.appid}:${r.discord_id}`,
    ),
  );

  // Regroupement par membre : un seul message par personne et par jour.
  const byMember = new Map<string, { appid: number; name: string }[]>();

  for (const game of games) {
    for (const steamid of game.wishers) {
      const discordId = discordBySteam.get(steamid);
      if (!discordId || !optedIn.has(discordId)) continue;
      if (alreadySent.has(`${game.appid}:${discordId}`)) continue;

      const list = byMember.get(discordId) ?? [];
      list.push({ appid: game.appid, name: game.name });
      byMember.set(discordId, list);
    }
  }

  report.members = byMember.size;

  // Envoi séquentiel : Discord n'aime pas les rafales, et on veut tracer
  // chaque envoi réussi.
  for (const [discordId, list] of byMember) {
    const lines = list
      .slice(0, 10)
      .map((g) => `• **${g.name}** — https://store.steampowered.com/app/${g.appid}`);
    const more = list.length > 10 ? `\n… et ${list.length - 10} autre(s).` : '';

    const content =
      list.length === 1
        ? `🎮 <@${discordId}>, un jeu de ta wishlist sort aujourd'hui :\n${lines[0]}`
        : `🎮 <@${discordId}>, ${list.length} jeux de ta wishlist sortent aujourd'hui :\n${lines.join('\n')}${more}`;

    try {
      await sendChannelMessage(channelId, content);

      await db
        .insert(releaseNotifications)
        .values(
          list.map((g) => ({
            appid: g.appid,
            discordId,
            releaseDate: report.day,
          })),
        )
        .onConflictDoNothing();

      report.sent++;
    } catch (err: any) {
      report.errors.push(`${discordId}: ${err?.message ?? err}`);
      report.ok = false;
    }
  }

  await updateSettings({ lastReleaseNotifyAt: new Date() });
  return report;
}
