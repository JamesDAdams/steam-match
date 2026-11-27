import { getDb } from '../db/index.ts';
import { discordEvents, gameCache } from '../db/schema.ts';
import { eq } from 'drizzle-orm';
import { getSettings } from './settings.ts';
import type { PostRights } from './discord-bot.ts';
import {
  deleteChannelMessage,
  editChannelMessage,
  ensureBotCanPost,
  eventDiscordUrl,
  getChannelName,
  sendChannelMessage,
} from './discord-bot.ts';
import { formatPrice } from './prices.ts';
import { applyInterest, mergeInterestLists } from './event-interest.ts';
import type { InterestUser } from './event-interest.ts';

/**
 * Annonce Discord d'un événement créé depuis le site.
 *
 * POURQUOI CE MODULE
 * ------------------
 * Un événement programmé Discord est affiché dans l'onglet « Événements » du
 * serveur, mais personne ne le remarque vraiment. On publie donc, à la
 * création, UN message dans un salon choisi par l'admin : il récapitule tout
 * (description, jeu, lien, prix Steam, prix en clé, participants, « peut-être »)
 * et porte deux boutons — « Je participe » et « Peut-être » — dont les clics
 * sont traités par /api/discord/interactions.
 *
 * Le message est ensuite ÉDITÉ (jamais reposté) à chaque changement de liste :
 * le salon ne se remplit pas d'un message par clic.
 */

/** Bornes Discord des embeds. */
const MAX_DESCRIPTION = 4096;
const MAX_FIELD_VALUE = 1024;
const MAX_TITLE = 256;

/** Ligne de prix ajoutée automatiquement à la description du formulaire. */
const PRICE_LINE = /^(?:prix steam|prix en clé)\s*:/i;

interface EventRow {
  id: string;
  name: string;
  description: string | null;
  status: number;
  entityType: number;
  location: string | null;
  channelId: string | null;
  channelName: string | null;
  coverImage: string | null;
  gameAppid: number | null;
  scheduledStartAt: Date;
  scheduledEndAt: Date | null;
  interestedUsers: unknown;
  siteInterestedUsers: unknown;
  maybeUsers: unknown;
}

/* ─────────────────────────── Chargement ─────────────────────────── */

async function loadEvent(eventId: string): Promise<EventRow | null> {
  const db = getDb();
  const [row] = await db
    .select({
      id: discordEvents.id,
      name: discordEvents.name,
      description: discordEvents.description,
      status: discordEvents.status,
      entityType: discordEvents.entityType,
      location: discordEvents.location,
      channelId: discordEvents.channelId,
      channelName: discordEvents.channelName,
      coverImage: discordEvents.coverImage,
      gameAppid: discordEvents.gameAppid,
      scheduledStartAt: discordEvents.scheduledStartAt,
      scheduledEndAt: discordEvents.scheduledEndAt,
      interestedUsers: discordEvents.interestedUsers,
      siteInterestedUsers: discordEvents.siteInterestedUsers,
      maybeUsers: discordEvents.maybeUsers,
    })
    .from(discordEvents)
    .where(eq(discordEvents.id, eventId))
    .limit(1);

  return (row as EventRow | undefined) ?? null;
}

export interface AnnouncementGame {
  appid: number;
  name: string;
  steamPrice: number | null;
  steamInitialPrice: number | null;
  steamDiscount: number | null;
  steamCurrency: string | null;
  cheapestPrice: number | null;
  cheapestStore: string | null;
  cheapestCurrency: string | null;
}

/** Nom, prix Steam et prix en clé du jeu associé (null si aucun jeu). */
async function loadGame(appid: number | null): Promise<AnnouncementGame | null> {
  if (!appid) return null;

  const db = getDb();
  const [row] = await db
    .select({
      appid: gameCache.appid,
      name: gameCache.name,
      steamPrice: gameCache.steamPrice,
      steamInitialPrice: gameCache.steamInitialPrice,
      steamDiscount: gameCache.steamDiscount,
      steamCurrency: gameCache.steamCurrency,
      cheapestPrice: gameCache.cheapestPrice,
      cheapestStore: gameCache.cheapestStore,
      cheapestCurrency: gameCache.cheapestCurrency,
    })
    .from(gameCache)
    .where(eq(gameCache.appid, appid))
    .limit(1);

  return row ?? null;
}

/* ─────────────────────────── Mise en forme ─────────────────────────── */

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Coupe proprement, sans laisser une phrase en plein milieu d'un mot. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Retire les lignes « Prix Steam : … » / « Prix en clé : … » de la fin de la
 * description : elles sont déjà affichées dans des champs dédiés, plus lisibles
 * et toujours à jour (le texte, lui, est figé à la création).
 */
export function stripPriceLines(text: string | null): string {
  if (!text) return '';
  const lines = text.split('\n');
  while (lines.length > 0) {
    const last = lines[lines.length - 1].trim();
    if (last === '' || PRICE_LINE.test(last)) {
      lines.pop();
      continue;
    }
    break;
  }
  return lines.join('\n').trim();
}

const DAY_FMT = new Intl.DateTimeFormat('fr-FR', {
  timeZone: 'Europe/Paris',
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

const TIME_FMT = new Intl.DateTimeFormat('fr-FR', {
  timeZone: 'Europe/Paris',
  hour: '2-digit',
  minute: '2-digit',
});

/** « vendredi 28 novembre 2026 · 20:30 → 22:30 » */
export function formatWhen(start: Date, end: Date | null): string {
  const day = DAY_FMT.format(start);
  const from = TIME_FMT.format(start);
  if (!end) return `${day} · ${from}`;
  const sameDay = DAY_FMT.format(end) === day;
  return sameDay
    ? `${day} · ${from} → ${TIME_FMT.format(end)}`
    : `${day} · ${from} → ${DAY_FMT.format(end)} · ${TIME_FMT.format(end)}`;
}

function participants(users: InterestUser[], max: number): string {
  if (users.length === 0) return 'Personne pour l’instant';
  const names = users.map((u) => u.name);
  let out = '';
  let shown = 0;
  for (const name of names) {
    const next = out ? `${out}, ${name}` : name;
    if (next.length > max) break;
    out = next;
    shown++;
  }
  const rest = names.length - shown;
  return clip(rest > 0 ? `${out} et ${rest} autre${rest > 1 ? 's' : ''}` : out, MAX_FIELD_VALUE);
}

function steamGameUrl(appid: number): string {
  return `https://store.steampowered.com/app/${appid}/`;
}

/** Lien du site public (fourni par Netlify), sans valeur en dur. */
function siteHost(): string {
  const raw = (process.env.URL || process.env.DEPLOY_PRIME_URL || '').replace(/\/+$/, '');
  return raw.replace(/^https?:\/\//, '');
}

/* ─────────────────────────── Payload Discord ─────────────────────────── */

export interface AnnouncementPayload {
  embeds: Record<string, unknown>[];
  components: Record<string, unknown>[];
}

export const BUTTON_INTERESTED = 'in';
export const BUTTON_MAYBE = 'maybe';

/** `evt:<kind>:<eventId>` — relu par le handler d'interactions. */
export function buttonCustomId(kind: 'in' | 'maybe', eventId: string): string {
  return `evt:${kind}:${eventId}`;
}

/** Décode un custom_id de bouton d'annonce (null si ce n'est pas le nôtre). */
export function parseButtonCustomId(
  customId: string,
): { kind: 'interested' | 'maybe'; eventId: string } | null {
  const m = /^evt:(in|maybe):(\d{17,20})$/.exec(customId ?? '');
  if (!m) return null;
  return { kind: m[1] === 'in' ? 'interested' : 'maybe', eventId: m[2] };
}

/**
 * Construit l'embed et les boutons.
 *
 * Séparé de l'envoi : le handler d'interaction renvoie exactement le même
 * payload en réponse au clic (type 7 « UPDATE_MESSAGE »), ce qui met le message
 * à jour sans second appel à Discord.
 */
export async function buildAnnouncement(
  event: EventRow,
  opts: { closed?: boolean; game?: AnnouncementGame | null } = {},
): Promise<AnnouncementPayload> {
  // Le jeu peut être fourni par l'appelant : le clic sur un bouton n'a alors
  // plus AUCUNE requête à faire pour construire le message.
  const game = opts.game !== undefined ? opts.game : await loadGame(event.gameAppid);

  const interested = (Array.isArray(event.interestedUsers) ? event.interestedUsers : []) as InterestUser[];
  const site = (Array.isArray(event.siteInterestedUsers) ? event.siteInterestedUsers : []) as InterestUser[];
  const maybe = (Array.isArray(event.maybeUsers) ? event.maybeUsers : []) as InterestUser[];
  const lists = mergeInterestLists(interested, site, maybe);

  // `location` ne porte le salon que pour un événement vocal créé à la main
  // sur Discord ; le site reçoit `channel_id`, plus fiable.
  const voiceChannelId =
    event.entityType === 2
      ? [event.channelId, event.location].find((v) => v && /^\d{17,20}$/.test(v)) ?? null
      : null;

  /**
   * Le nom du salon est mémorisé en base dès la création. Il n'est demandé à
   * Discord que s'il manque (événement venu de Discord, ou créé avant cette
   * colonne) — et on le retient alors pour les fois suivantes.
   */
  let where = event.channelName;
  if (!where && voiceChannelId) {
    where = await getChannelName(voiceChannelId).catch(() => null);
    if (where) {
      await getDb()
        .update(discordEvents)
        .set({ channelName: where })
        .where(eq(discordEvents.id, event.id))
        .catch(() => undefined);
    }
  }

  const place =
    event.entityType === 2
      ? where
        ? `🎧 Salon vocal « ${where} »`
        : '🎧 Salon vocal du serveur'
      : event.location
        ? event.location
        : 'À préciser';

  const fields: Record<string, unknown>[] = [];

  if (game) {
    fields.push({
      name: '🎮 Jeu',
      value: `[${clip(game.name, 80)}](${steamGameUrl(game.appid)})`,
      inline: true,
    });

    const steam =
      game.steamPrice == null
        ? '—'
        : game.steamDiscount
          ? `${formatPrice(game.steamPrice, game.steamCurrency ?? 'EUR')} (−${game.steamDiscount} %)`
          : formatPrice(game.steamPrice, game.steamCurrency ?? 'EUR');

    fields.push({ name: '💶 Prix Steam', value: steam, inline: true });

    const key = game.cheapestPrice == null
      ? '—'
      : `${formatPrice(game.cheapestPrice, game.cheapestCurrency ?? 'EUR')}${
          game.cheapestStore ? ` · ${game.cheapestStore}` : ''
        }`;
    fields.push({ name: '🔑 Prix en clé', value: key, inline: true });
  }

  fields.push({ name: '📅 Quand', value: formatWhen(event.scheduledStartAt, event.scheduledEndAt), inline: false });
  fields.push({ name: '📍 Où', value: place, inline: false });
  fields.push({
    name: `👍 Je participe (${lists.interested.length})`,
    value: participants(lists.interested, 900),
    inline: false,
  });
  fields.push({
    name: `❔ Peut-être (${lists.maybe.length})`,
    value: participants(lists.maybe, 900),
    inline: false,
  });

  const body = stripPriceLines(event.description);
  const summary = body
    ? clip(body, MAX_DESCRIPTION)
    : '_Aucune description — dis-nous juste si tu viens !_';

  const embed: Record<string, unknown> = {
    title: clip(event.name, MAX_TITLE),
    url: eventDiscordUrl(event.id),
    description: summary,
    color: 0xd4af37,
    fields,
    author: { name: 'Le Bastion des Gamers · nouvel événement' },
    footer: { text: `Clique sur un bouton pour répondre · ${siteHost() || 'site du Bastion'}` },
  };

  if (event.coverImage) embed.image = { url: event.coverImage };

  const closed = opts.closed ?? (event.status === 3 || event.status === 4);
  const components = [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 3,
          label: '👍 Je participe',
          custom_id: buttonCustomId(BUTTON_INTERESTED, event.id),
          disabled: closed,
        },
        {
          type: 2,
          style: 2,
          label: '❔ Peut-être',
          custom_id: buttonCustomId(BUTTON_MAYBE, event.id),
          disabled: closed,
        },
      ],
    },
  ];

  return { embeds: [embed], components };
}

/* ─────────────────────────── Publication ─────────────────────────── */

export interface PublishAnnouncementResult {
  published: boolean;
  reason?: string;
  messageId?: string | null;
  channelId?: string | null;
  /** Le bot s'est autorisé l'écriture dans le salon pour y arriver. */
  grantedPermissions?: boolean;
}

/**
 * Publie l'annonce d'un événement dans le salon configuré.
 *
 * Appelée juste après la création : un échec ne remet pas en cause
 * l'événement, il est seulement signalé à l'admin.
 */
export async function publishEventAnnouncement(
  eventId: string,
): Promise<PublishAnnouncementResult> {
  const settings = await getSettings();
  const channelId = settings.eventAnnounceChannelId;
  if (!channelId) return { published: false, reason: 'no-channel' };

  const event = await loadEvent(eventId);
  if (!event) return { published: false, reason: 'event-not-found' };

  const payload = await buildAnnouncement(event);

  const rights = await ensureBotCanPost(channelId).catch(
    (err: any): PostRights => ({
      canPost: false,
      missing: [] as string[],
      reason: err?.message ?? 'vérification impossible',
    }),
  );

  if (!rights.canPost) {
    return {
      published: false,
      reason:
        rights.reason ??
        `Le bot ne peut pas écrire dans ce salon${rights.missing?.length ? ` (${rights.missing.join(', ')})` : ''}.`,
    };
  }

  try {
    const messageId = await sendChannelMessage(channelId, '', payload);

    await getDb()
      .update(discordEvents)
      .set({ announceMessageId: messageId || null, announceChannelId: channelId })
      .where(eq(discordEvents.id, eventId));

    return {
      published: true,
      messageId,
      channelId,
      grantedPermissions: rights.granted ?? false,
    };
  } catch (err: any) {
    console.error('[annonce événement]', err?.message);
    return { published: false, reason: err?.message ?? 'erreur Discord' };
  }
}

/**
 * Réécrit l'annonce existante (clic sur le site, ou intéressés venus de
 * Discord). Ne fait rien si l'événement n'a pas d'annonce : on n'en crée pas
 * rétroactivement pour les événements antérieurs au réglage.
 */
export async function refreshEventAnnouncement(
  eventId: string,
): Promise<{ updated: boolean; reason?: string }> {
  const db = getDb();

  const [row] = await db
    .select({
      messageId: discordEvents.announceMessageId,
      channelId: discordEvents.announceChannelId,
    })
    .from(discordEvents)
    .where(eq(discordEvents.id, eventId))
    .limit(1);

  if (!row?.messageId || !row.channelId) return { updated: false, reason: 'no-announcement' };

  const event = await loadEvent(eventId);
  if (!event) return { updated: false, reason: 'event-not-found' };

  const payload = await buildAnnouncement(event);

  try {
    const ok = await editChannelMessage(row.channelId, row.messageId, '', payload);
    if (!ok) {
      /**
       * Message supprimé à la main : on efface la référence pour ne pas
       * réessayer indéfiniment. On ne reposte pas : le message de test d'un
       * membre ne doit pas réapparaître dans le salon contre son gré.
       */
      await db
        .update(discordEvents)
        .set({ announceMessageId: null, announceChannelId: null })
        .where(eq(discordEvents.id, eventId));
      return { updated: false, reason: 'message-missing' };
    }
    return { updated: true };
  } catch (err: any) {
    console.warn('[annonce événement] mise à jour impossible :', err?.message);
    return { updated: false, reason: err?.message ?? 'erreur Discord' };
  }
}

/** Supprime l'annonce d'un événement supprimé (silencieux si absente). */
export async function deleteEventAnnouncement(eventId: string): Promise<void> {
  const db = getDb();
  const [row] = await db
    .select({
      messageId: discordEvents.announceMessageId,
      channelId: discordEvents.announceChannelId,
    })
    .from(discordEvents)
    .where(eq(discordEvents.id, eventId))
    .limit(1);

  if (!row?.messageId || !row.channelId) return;

  try {
    await deleteChannelMessage(row.channelId, row.messageId);
  } catch {
    /* message déjà supprimé : rien à faire */
  }
}

/* ───────────────────── Clic sur un bouton Discord ───────────────────── */

export type ToggleResult =
  | { ok: true; payload: AnnouncementPayload; active: boolean; interested: number; maybe: number }
  | { ok: false; reason: 'not-found' | 'closed' | 'unknown-button' };

/**
 * Applique un clic de bouton venu de Discord.
 *
 * Même logique que le site : cliquer à nouveau retire l'inscription, et
 * « Je participe » / « Peut-être » s'excluent (setInterest s'en charge dans la
 * même transaction logique).
 */
export async function toggleFromDiscord(args: {
  eventId: string;
  kind: 'interested' | 'maybe';
  user: { id: string; name: string; avatarUrl: string | null };
}): Promise<ToggleResult> {
  const db = getDb();

  const [state] = await db
    .select({
      status: discordEvents.status,
      siteInterested: discordEvents.siteInterestedUsers,
      maybe: discordEvents.maybeUsers,
    })
    .from(discordEvents)
    .where(eq(discordEvents.id, args.eventId))
    .limit(1);

  if (!state) return { ok: false, reason: 'not-found' };
  if (state.status === 3 || state.status === 4) return { ok: false, reason: 'closed' };

  const current = (args.kind === 'interested' ? state.siteInterested : state.maybe) ?? [];
  const already = (Array.isArray(current) ? current : []).some(
    (u: any) => String(u?.id) === args.user.id,
  );

  /**
   * UNE SEULE requête : bascule de l'inscription ET relecture de la ligne
   * complète (listes, nom, description, jeu). C'est ce qui fait tenir la
   * réponse sous la limite de 3 secondes imposée par Discord.
   */
  const applied = await applyInterest(args.eventId, args.kind, args.user, !already);
  if (!applied) return { ok: false, reason: 'not-found' };

  const event = rowToEvent(applied.row);
  const game = (applied.row.game ?? null) as AnnouncementGame | null;

  return {
    ok: true,
    payload: await buildAnnouncement(event, { game }),
    active: !already,
    interested: applied.lists.interested.length,
    maybe: applied.lists.maybe.length,
  };
}

/** Ligne brute (`RETURNING *`) → objet attendu par `buildAnnouncement`. */
function rowToEvent(row: Record<string, any>): EventRow {
  return {
    id: String(row.id),
    name: String(row.name ?? 'Événement'),
    description: row.description ?? null,
    status: Number(row.status ?? 1),
    entityType: Number(row.entity_type ?? 3),
    location: row.location ?? null,
    channelId: row.channel_id ?? null,
    channelName: row.channel_name ?? null,
    coverImage: row.cover_image ?? null,
    gameAppid: row.game_appid ?? null,
    scheduledStartAt: new Date(row.scheduled_start_at),
    scheduledEndAt: row.scheduled_end_at ? new Date(row.scheduled_end_at) : null,
    interestedUsers: row.interested_users ?? [],
    siteInterestedUsers: row.site_interested_users ?? [],
    maybeUsers: row.maybe_users ?? [],
  };
}
