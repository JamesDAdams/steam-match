import { getDb } from '../db/index.ts';
import { discordEvents } from '../db/schema.ts';
import { max, sql } from 'drizzle-orm';
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

  // Réconciliation : tout ce que Discord ne renvoie plus disparaît de la base.
  //
  // POURQUOI MÊME QUAND LA LISTE EST VIDE : une liste vide est une réponse
  // valide (« il n'y a plus aucun événement »). L'ancien garde-fou
  // `if (events.length > 0)` laissait donc les événements supprimés sur
  // Discord affichés indéfiniment sur le site — le cas le plus fréquent,
  // puisque le dernier événement supprimé est justement le dernier restant.
  //
  // Une erreur d'accès, elle, lève avant d'arriver ici (getScheduledEvents),
  // donc on ne confond pas « plus rien » avec « je ne vois plus rien ».
  const guild = guildId();
  const keep = events.map((e) => e.id);

  if (keep.length > 0) {
    await db.execute(sql`
      DELETE FROM discord_events
      WHERE guild_id = ${guild}
        AND id NOT IN (${sql.join(
          keep.map((id) => sql`${id}`),
          sql`, `,
        )})
    `);
  } else {
    await db.execute(sql`
      DELETE FROM discord_events
      WHERE guild_id = ${guild}
    `);
  }

  return { synced: events.length, syncedAt: now, events };
}

/**
 * Synchronisation « de fond » : rafraîchit la base au plus une fois par
 * intervalle, sans bloquer ni ralentir les appels suivants.
 *
 * POURQUOI : sans elle, la page des événements ne lisait QUE la base. Un
 * événement supprimé sur Discord restait donc affiché jusqu'à ce qu'un admin
 * pense à cliquer « Synchroniser » — c'est exactement le bug constaté.
 *
 * Le garde-fou est double : un horodatage en mémoire (par instance) et le
 * `synced_at` le plus récent en base, pour ne pas marteler l'API Discord quand
 * plusieurs instances tournent. L'intervalle est court (15 s) parce qu'un
 * événement supprimé juste avant doit disparaître tout de suite : c'est le cas
 * d'usage, pas l'exception.
 */
const AUTO_SYNC_MIN_INTERVAL_MS = 15_000;
let lastAttemptAt = 0;

export async function syncDiscordEventsIfStale(
  minIntervalMs = AUTO_SYNC_MIN_INTERVAL_MS,
): Promise<{ skipped: boolean; synced?: number }> {
  const now = Date.now();
  if (now - lastAttemptAt < minIntervalMs) return { skipped: true };

  // Base déjà fraîche : inutile d'appeler Discord (cas d'une instance froide).
  try {
    const db = getDb();
    const [row] = await db
      .select({ at: max(discordEvents.syncedAt) })
      .from(discordEvents);
    if (row?.at && now - new Date(row.at).getTime() < minIntervalMs) {
      lastAttemptAt = now;
      return { skipped: true };
    }
  } catch {
    /* lecture impossible : on tente la synchronisation, Discord tranchera */
  }

  lastAttemptAt = now;
  try {
    const { synced } = await syncDiscordEvents();
    return { skipped: false, synced };
  } catch (err) {
    lastAttemptAt = 0; // échec : on réessaiera au prochain appel
    throw err;
  }
}
