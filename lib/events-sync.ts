import { getDb } from '../db/index.ts';
import { discordEvents, syncState } from '../db/schema.ts';
import { sql } from 'drizzle-orm';
import {
  getScheduledEvents,
  getEventInterestedUsers,
  eventCoverUrl,
  guildId,
} from './discord-bot.ts';
import type { DiscordScheduledEvent } from './discord-bot.ts';
import { stripSiteBlock, syncDescription } from './event-interest.ts';
import { refreshEventAnnouncement } from './event-announcement.ts';

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
/**
 * Écrit (ou met à jour) un événement Discord en base.
 *
 * Exporté pour que la création depuis le site n'ait pas à relancer une
 * synchronisation complète : un POST suivi d'un GET immédiat sur les
 * événements tombe dans le même bucket très serré de Discord et récolte un 429.
 */
export async function storeEvent(
  e: DiscordScheduledEvent,
  now = new Date(),
  extra: { gameAppid?: number | null } = {},
): Promise<void> {
  const start = new Date(e.scheduled_start_time);
  if (Number.isNaN(start.getTime())) return;

  const values = {
    id: e.id,
    guildId: e.guild_id ?? guildId(),
    name: e.name,
    // La description stockée est la description D'ORIGINE : le bloc
    // « Inscriptions du site » qu'on y ajoute ne doit pas être réaffiché dans
    // la fiche (ni recopié une deuxième fois au prochain envoi).
    description: stripSiteBlock(e.description ?? null),
    status: e.status ?? 1,
    entityType: e.entity_type ?? 3,
    location: e.entity_metadata?.location ?? null,
    channelId: e.channel_id ?? null,
    coverImage: eventCoverUrl(e.id, e.image),
    interestedCount: e.user_count ?? 0,
    scheduledStartAt: start,
    scheduledEndAt: e.scheduled_end_time ? new Date(e.scheduled_end_time) : null,
    syncedAt: now,
    // Le jeu associé n'est connu qu'à la création depuis le site : une
    // synchronisation Discord ne doit jamais l'effacer.
    ...(extra.gameAppid ? { gameAppid: extra.gameAppid } : {}),
  };

  await getDb()
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
        channelId: values.channelId,
        coverImage: values.coverImage,
        interestedCount: values.interestedCount,
        scheduledStartAt: values.scheduledStartAt,
        scheduledEndAt: values.scheduledEndAt,
        syncedAt: now,
        ...(extra.gameAppid ? { gameAppid: extra.gameAppid } : {}),
      },
    });
}

export async function syncDiscordEvents(): Promise<{
  synced: number;
  syncedAt: Date;
  events: DiscordScheduledEvent[];
}> {
  const events = await getScheduledEvents();
  const db = getDb();
  const now = new Date();

  // Âge de la dernière lecture des « intéressés », pour ne pas relancer un
  // appel Discord par événement à chaque synchronisation (toutes les 15 s).
  const known = new Map<string, Date | null>();
  /** Empreinte des intéressés connus, pour ne réécrire la description que si elle change. */
  const previousInterested = new Map<string, string>();
  try {
    const rows = await db
      .select({
        id: discordEvents.id,
        at: discordEvents.interestedSyncedAt,
        users: discordEvents.interestedUsers,
      })
      .from(discordEvents);
    for (const r of rows) {
      known.set(r.id, r.at ?? null);
      if (Array.isArray(r.users)) {
        previousInterested.set(
          r.id,
          r.users.map((u: any) => u.id).sort().join(','),
        );
      }
    }
  } catch {
    /* lecture impossible : on relira les intéressés */
  }

  for (const e of events) {
    await storeEvent(e, now);
  }

  // Liste des personnes intéressées : une requête Discord par événement, donc
  // rafraîchie avec parcimonie (5 min) et plafonnée par synchronisation.
  // 2 minutes : un clic « Intéressé » fait sur Discord doit apparaître vite
  // sur le site et dans la description. Le cron tourne toutes les 5 minutes,
  // donc chaque passage rafraîchit effectivement la liste.
  const INTERESTED_TTL_MS = 2 * 60_000;
  // Discord limite fortement les appels par événement (bucket « 1 requête
  // toutes les quelques secondes ») : on en rafraîchit donc peu à la fois, en
  // commençant par les plus anciens. La liste est stable, inutile d'insister.
  const MAX_INTERESTED_FETCH = 5;
  const INTERESTED_SPACING_MS = 1_200;

  const needUsers = events
    .filter((e) => e.status !== 3 && e.status !== 4) // terminés / annulés : figés
    .filter((e) => {
      const at = known.get(e.id);
      return !at || now.getTime() - at.getTime() > INTERESTED_TTL_MS;
    })
    .sort((a, b) => {
      const ta = known.get(a.id)?.getTime() ?? 0;
      const tb = known.get(b.id)?.getTime() ?? 0;
      return ta - tb; // jamais lus (0) d'abord, puis les plus anciens
    })
    .slice(0, MAX_INTERESTED_FETCH);

  for (const [i, e] of needUsers.entries()) {
    if (i > 0) await new Promise((r) => setTimeout(r, INTERESTED_SPACING_MS));
    try {
      const users = await getEventInterestedUsers(e.id);
      await db
        .update(discordEvents)
        .set({ interestedUsers: users, interestedSyncedAt: now })
        .where(sql`${discordEvents.id} = ${e.id}`);

      /**
       * Quelqu'un a coché « Intéressé » SUR DISCORD : la description doit le
       * refléter. On ne réécrit que si la liste a réellement changé, pour ne
       * pas envoyer un PATCH à chaque synchronisation.
       */
      const fingerprint = users.map((u) => u.id).sort().join(',');
      if (fingerprint !== (previousInterested.get(e.id) ?? '')) {
        await syncDescription(e.id).catch((err: any) =>
          console.warn('[events-sync] description non mise à jour :', err?.message),
        );
        // L'annonce du salon affiche aussi les participants : elle doit
        // suivre, sinon le message contredit la fiche de l'événement.
        await refreshEventAnnouncement(e.id).catch((err: any) =>
          console.warn('[events-sync] annonce non mise à jour :', err?.message),
        );
      }
    } catch (err: any) {
      // Un événement illisible ne doit pas empêcher la synchronisation des
      // autres : on réessaiera au prochain passage.
      console.warn(`[events-sync] intéressés de ${e.id} :`, err?.message);
      break; // limite de débit probable : on s'arrête là pour cette fois
    }
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

  // Trace de la synchronisation, même sans aucun événement : c'est ce qui
  // évite de rappeler Discord à chaque chargement de page quand la liste est vide.
  await db
    .insert(syncState)
    .values({ id: 'events', eventsSyncedAt: now })
    .onConflictDoUpdate({
      target: syncState.id,
      set: { eventsSyncedAt: now },
    })
    .catch((err: any) => {
      console.warn('[events-sync] état non enregistré :', err?.message);
    });

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
const AUTO_SYNC_MIN_INTERVAL_MS = 20_000;

/** Pause imposée après un 429 de Discord (au-delà de l'intervalle normal). */
const RATE_LIMIT_COOLDOWN_MS = 2 * 60_000;
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
      .select({ at: syncState.eventsSyncedAt })
      .from(syncState)
      .where(sql`${syncState.id} = 'events'`)
      .limit(1);
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
  } catch (err: any) {
    // 429 : Discord demande une pause. On se cale bien au-delà de l'intervalle
    // plutôt que de retenter à chaque affichage de page et d'aggraver la limite.
    const rateLimited = /429/.test(String(err?.message ?? ''));
    lastAttemptAt = rateLimited ? Date.now() + RATE_LIMIT_COOLDOWN_MS : 0;
    throw err;
  }
}
