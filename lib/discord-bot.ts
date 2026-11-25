/**
 * Accès aux événements du serveur Discord (Guild Scheduled Events).
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
 * On lit les événements, on n'en crée pas : Discord reste la source de vérité.
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
  user_count?: number;
  image?: string | null;
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
 * Récupère tous les événements programmés du serveur.
 * `with_user_count=true` donne le nombre de personnes intéressées.
 */
export async function getScheduledEvents(): Promise<DiscordScheduledEvent[]> {
  const url = `${API_BASE}/guilds/${guildId()}/scheduled-events?with_user_count=true`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bot ${botToken()}`,
      'Content-Type': 'application/json',
    },
  });

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
