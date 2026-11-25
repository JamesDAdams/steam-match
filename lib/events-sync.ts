import { getDb } from '../db/index.ts';
import { discordEvents } from '../db/schema.ts';
import { sql } from 'drizzle-orm';
import { getScheduledEvents, eventCoverUrl, guildId } from './discord-bot.ts';
import type { DiscordScheduledEvent } from './discord-bot.ts';

/**
 * Recopie les événements du serveur Discord en base.
 *
 * Factorisé ici parce que deux chemins en ont besoin : la synchronisation
 * manuelle (bouton) et la création d'un événement depuis le site — après
 * création, on veut voir l'événement apparaître sans attendre un clic.
 *
 * Discord reste la source de vérité : on met à jour, on insère, et on
 * supprime ce qui n'existe plus côté Discord.
 */
export async function syncDiscordEvents(): Promise<{
  synced: number;
  syncedAt: Date;
  events: DiscordScheduledEvent[];
}> {
  const events = await getScheduledEvents();
  const db = getDb();
  const now = new Date();

  for (const e of events) {
    const start = new Date(e.scheduled_start_time);
    if (Number.isNaN(start.getTime())) continue;

    const values = {
      id: e.id,
      guildId: e.guild_id ?? guildId(),
      name: e.name,
      description: e.description ?? null,
      status: e.status ?? 1,
      entityType: e.entity_type ?? 3,
      location: e.entity_metadata?.location ?? null,
      coverImage: eventCoverUrl(e.id, e.image),
      interestedCount: e.user_count ?? 0,
      scheduledStartAt: start,
      scheduledEndAt: e.scheduled_end_time ? new Date(e.scheduled_end_time) : null,
      syncedAt: now,
    };

    await db
      .insert(discordEvents)
      .values(values)
      .onConflictDoUpdate({
        target: discordEvents.id,
        set: {
          name: values.name,
          description: values.description,
          status: values.status,
          entityType: values.entityType,
          location: values.location,
          coverImage: values.coverImage,
          interestedCount: values.interestedCount,
          scheduledStartAt: values.scheduledStartAt,
          scheduledEndAt: values.scheduledEndAt,
          syncedAt: now,
        },
      });
  }

  // Retire les événements supprimés côté Discord.
  // Si Discord ne renvoie RIEN, on ne supprime rien : ça peut être un serveur
  // sans événement, mais aussi une permission retirée par erreur.
  if (events.length > 0) {
    const keep = events.map((e) => e.id);
    await db.execute(sql`
      DELETE FROM discord_events
      WHERE id NOT IN (${sql.join(
        keep.map((id) => sql`${id}`),
        sql`, `,
      )})
    `);
  }

  return { synced: events.length, syncedAt: now, events };
}
