/**
 * Accès au serveur Discord via un BOT (API REST).
 *
 * Trois usages :
 *   1. Lire les événements programmés (page Événements)
 *   2. CRÉER un événement depuis le site (modal admin)
 *   3. Vérifier qu'un compte est bien MEMBRE du serveur (contrôle d'accès)
 *
 * PRÉREQUIS
 * ---------
 * - Un BOT Discord (pas l'application OAuth du site) : DISCORD_BOT_TOKEN
 * - Ce bot doit être membre du serveur, avec la permission « Gérer les
 *   événements ». AUCUNE intention privilégiée n'est requise : on passe par
 *   l'API REST, pas par la passerelle temps réel — le bot n'a donc pas besoin
 *   d'être en ligne (et n'apparaîtra pas dans la liste des membres).
 * - DISCORD_GUILD_ID : identifiant du serveur
 *
 * Si ces variables sont absentes, le site reste utilisable : le contrôle
 * d'appartenance est désactivé et seuls les comptes autorisés manuellement
 * (page admin) peuvent entrer.
 */

const API_BASE = 'https://discord.com/api/v10';

export interface DiscordScheduledEvent {
  id: string;
  guild_id: string;
  name: string;
  description?: string | null;
  scheduled_start_time: string;
  scheduled_end_time?: string | null;
  status: number;
  entity_type: number;
  entity_metadata?: { location?: string | null } | null;
  channel_id?: string | null;
  user_count?: number;
  image?: string | null;
}

export interface DiscordGuildMember {
  user?: { id: string; username: string; global_name?: string | null };
  nick?: string | null;
  joined_at?: string;
}

export interface DiscordChannel {
  id: string;
  name: string;
  /** 2 = vocal, 13 = scène. On ne garde que ces deux types. */
  type: number;
  position: number;
  parent_id?: string | null;
}

export function botToken(): string {
  const t = process.env.DISCORD_BOT_TOKEN;
  if (!t) {
    throw new Error(
      'DISCORD_BOT_TOKEN manquant. Crée un bot sur https://discord.com/developers/applications, ' +
        'ajoute-le au serveur, puis renseigne le jeton dans les variables d’environnement.',
    );
  }
  return t;
}

export function guildId(): string {
  const g = process.env.DISCORD_GUILD_ID;
  if (!g) {
    throw new Error(
      'DISCORD_GUILD_ID manquant. Active le mode développeur sur Discord, ' +
        'clic droit sur ton serveur → Copier l’identifiant du serveur.',
    );
  }
  return g;
}

/**
 * Vrai si le bot peut être interrogé.
 *
 * On ne lève PAS d'exception : l'absence de bot est un état normal (site
 * utilisable avec la seule liste blanche), pas une erreur d'exécution.
 */
export function isBotConfigured(): boolean {
  return Boolean(process.env.DISCORD_BOT_TOKEN && process.env.DISCORD_GUILD_ID);
}

/** Lien d'invitation au serveur, facultatif (DISCORD_INVITE_URL). */
export function inviteUrl(): string | null {
  const v = process.env.DISCORD_INVITE_URL?.trim();
  return v || null;
}

/* ─────────────────────────── Transport ─────────────────────────── */

function discordFetch(path: string, init: RequestInit = {}) {
  return fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bot ${botToken()}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

/**
 * Vérifie que le bot voit bien le serveur, AVANT de conclure quoi que ce soit
 * sur un membre.
 *
 * POURQUOI : `GET /guilds/{id}/members/{user}` renvoie 404 aussi bien quand la
 * personne n'est pas membre que quand le bot lui-même n'est pas sur le
 * serveur. Sans cette sonde, un bot mal configuré ferait passer TOUS les
 * membres pour des intrus.
 *
 * Le résultat est mémorisé quelques minutes : la vérification d'appartenance
 * est appelée à chaque connexion, et une instance serverless chaude enchaîne
 * les requêtes.
 */
const GUILD_PROBE_TTL_MS = 5 * 60_000;

let guildProbe: { ok: boolean; at: number; message?: string } | null = null;

async function assertGuildAccessible(): Promise<void> {
  const now = Date.now();

  if (guildProbe && now - guildProbe.at < GUILD_PROBE_TTL_MS) {
    if (guildProbe.ok) return;
    throw new Error(guildProbe.message ?? 'Serveur Discord inaccessible.');
  }

  const res = await discordFetch(`/guilds/${guildId()}`);

  if (res.ok) {
    guildProbe = { ok: true, at: now };
    return;
  }

  let message: string;
  if (res.status === 404) {
    message =
      'Le bot n’est pas membre du serveur indiqué (404). Réinvite-le avec le scope « bot », ' +
      'ou vérifie DISCORD_GUILD_ID.';
  } else if (res.status === 401) {
    message =
      'Jeton du bot Discord refusé (401). Vérifie DISCORD_BOT_TOKEN et qu’il a bien été régénéré.';
  } else {
    message = `Discord a répondu HTTP ${res.status} en vérifiant l’accès au serveur.`;
  }

  guildProbe = { ok: false, at: now, message };
  throw new Error(message);
}

/* ─────────────────────── Contrôle d'appartenance ─────────────────────── */

/**
 * Renvoie le membre, ou null s'il n'est PAS sur le serveur.
 * Lève une exception si Discord est injoignable ou mal configuré : dans ce
 * cas l'appelant doit rester prudent et ne pas conclure « pas membre ».
 */
export async function getGuildMember(discordId: string): Promise<DiscordGuildMember | null> {
  await assertGuildAccessible();

  const res = await discordFetch(`/guilds/${guildId()}/members/${encodeURIComponent(discordId)}`);

  if (res.status === 404) return null;

  if (!res.ok) {
    throw new Error(
      `Discord a répondu HTTP ${res.status} en vérifiant le membre ${discordId} du serveur.`,
    );
  }

  return (await res.json()) as DiscordGuildMember;
}

/* ─────────────────────────── Salons ─────────────────────────── */

/**
 * Salons vocaux et scènes du serveur, pour le sélecteur du modal de création.
 *
 * `GET /guilds/{id}/channels` ne demande aucune intention privilégiée : il
 * suffit que le bot soit membre du serveur.
 */
export async function listEventChannels(): Promise<DiscordChannel[]> {
  await assertGuildAccessible();

  const res = await discordFetch(`/guilds/${guildId()}/channels`);

  if (!res.ok) {
    throw new Error(
      `Discord a répondu HTTP ${res.status} en lisant les salons du serveur.`,
    );
  }

  const data = (await res.json()) as DiscordChannel[];
  if (!Array.isArray(data)) return [];

  return data
    .filter((c) => c.type === 2 || c.type === 13)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
}

/* ─────────────────────────── Événements ─────────────────────────── */

/**
 * Récupère tous les événements programmés du serveur.
 * `with_user_count=true` donne le nombre de personnes intéressées.
 */
export async function getScheduledEvents(): Promise<DiscordScheduledEvent[]> {
  const res = await discordFetch(
    `/guilds/${guildId()}/scheduled-events?with_user_count=true`,
  );

  if (res.status === 401) {
    throw new Error(
      'Jeton du bot Discord refusé (401). Vérifie DISCORD_BOT_TOKEN et qu’il a bien été régénéré.',
    );
  }
  if (res.status === 403) {
    throw new Error(
      'Le bot n’a pas la permission de lire les événements (403). ' +
        'Vérifie qu’il est bien membre du serveur et qu’il a la permission ' +
        '« Gérer les événements ». Aucune intention privilégiée n’est requise.',
    );
  }
  if (res.status === 404) {
    throw new Error(
      'Le bot n’est pas membre du serveur indiqué (404). Réinvite-le avec le ' +
        'scope « bot » sur ce serveur, ou vérifie DISCORD_GUILD_ID.',
    );
  }
  if (!res.ok) {
    throw new Error(`Discord a répondu HTTP ${res.status} sur les événements du serveur.`);
  }

  const data = (await res.json()) as DiscordScheduledEvent[];
  return Array.isArray(data) ? data : [];
}

export interface CreateScheduledEventInput {
  name: string;
  description?: string | null;
  startAt: Date;
  endAt?: Date | null;
  /** 2 = vocal (salon requis), 3 = externe (lieu requis). */
  entityType: 2 | 3;
  channelId?: string | null;
  location?: string | null;
}

/**
 * Crée un événement programmé sur le serveur.
 *
 * `privacy_level: 2` = visible par tous les membres du serveur. On ne crée
 * jamais d'événement privé : le site sert la communauté entière.
 */
export async function createScheduledEvent(
  input: CreateScheduledEventInput,
): Promise<DiscordScheduledEvent> {
  const body: Record<string, unknown> = {
    name: input.name,
    privacy_level: 2,
    scheduled_start_time: input.startAt.toISOString(),
    entity_type: input.entityType,
  };

  if (input.description) body.description = input.description;
  if (input.endAt) body.scheduled_end_time = input.endAt.toISOString();

  if (input.entityType === 2) {
    body.channel_id = input.channelId;
  } else {
    body.entity_metadata = { location: input.location };
  }

  await assertGuildAccessible();

  const res = await discordFetch(`/guilds/${guildId()}/scheduled-events`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

  if (res.status === 403) {
    throw new Error(
      'Le bot n’a pas la permission de créer des événements (403). ' +
        'Sur Discord : Paramètres du serveur → Rôles → rôle du bot → active ' +
        '« Créer des événements » (et « Gérer les événements »). ' +
        'La permission cochée au moment de l’invitation ne suffit pas si elle ' +
        'a été retirée ensuite.',
    );
  }
  if (res.status === 400) {
    const text = await res.text().catch(() => '');
    throw new Error(
      'Discord a refusé la création (400) : ' +
        explainDiscordError(text) +
        ' Vérifie la date, le salon et le lieu.',
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `Discord a refusé la création (HTTP ${res.status}). ${text.slice(0, 300)}`.trim(),
    );
  }

  return (await res.json()) as DiscordScheduledEvent;
}

/** Traduit les erreurs de validation Discord en une phrase lisible. */
function explainDiscordError(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { message?: string; errors?: any };
    const detail = parsed.errors ? JSON.stringify(parsed.errors) : '';
    return `${parsed.message ?? 'requête invalide'}${detail ? ` (${detail})` : ''}`;
  } catch {
    return raw.slice(0, 200) || 'requête invalide';
  }
}

/** Construit l'URL publique de la bannière d'un événement. */
export function eventCoverUrl(
  eventId: string,
  imageHash: string | null | undefined,
): string | null {
  if (!imageHash) return null;
  return `https://cdn.discordapp.com/guild-events/${eventId}/${imageHash}.png?size=512`;
}

/** Lien vers l'événement sur Discord. */
export function eventDiscordUrl(eventId: string): string {
  try {
    return `https://discord.com/events/${guildId()}/${eventId}`;
  } catch {
    return 'https://discord.com';
  }
}
