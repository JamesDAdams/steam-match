import { getDb } from '../../db/index.ts';
import { discordEvents } from '../../db/schema.ts';
import { desc, eq, sql } from 'drizzle-orm';
import { requireAccess, requireAdmin } from '../access.ts';
import {
  getScheduledEvents,
  eventCoverUrl,
  guildId,
} from '../discord-bot.ts';

/**
 * GET  /api/events  → événements à venir et passés (membres autorisés)
 * POST /api/events  → synchronise depuis Discord (admin uniquement)
 *
 * Ce handler vit dans lib/handlers/ et non dans api/ : le plan Hobby de Vercel
 * plafonne à 12 fonctions, et api/ en compte déjà 12. Le routeur Netlify
 * l'expose via la fonction catch-all, sans consommer de place.
 */

/** Statuts Discord : 1 programmé, 2 en cours, 3 terminé, 4 annulé. */
const STATUS_LABEL: Record<number, string> = {
  1: 'Programmé',
  2: 'En cours',
  3: 'Terminé',
  4: 'Annulé',
};

/** 1 scène, 2 vocal, 3 externe. */
const ENTITY_LABEL: Record<number, string> = {
  1: 'Scène',
  2: 'Vocal',
  3: 'Externe',
};

export default async function handler(req: any, res: any) {
  const method = (req.method || 'GET').toUpperCase();

  if (method === 'POST') {
    return sync(req, res);
  }

  const ctx = await requireAccess(req, res);
  if (!ctx) return;

  try {
    const db = getDb();
    const now = new Date();

    const rows = await db
      .select()
      .from(discordEvents)
      .orderBy(desc(discordEvents.scheduledStartAt));

    const toDto = (e: typeof rows[number]) => ({
      id: e.id,
      name: e.name,
      description: e.description,
      status: e.status,
      statusLabel: STATUS_LABEL[e.status] ?? 'Inconnu',
      entityType: e.entityType,
      entityLabel: ENTITY_LABEL[e.entityType] ?? '',
      location: e.location,
      coverImage: e.coverImage,
      interestedCount: e.interestedCount,
      startAt: e.scheduledStartAt,
      endAt: e.scheduledEndAt,
      isPast: e.scheduledStartAt.getTime() < now.getTime(),
      isCancelled: e.status === 4,
    });

    const all = rows.map(toDto);

    const [lastSyncRow] = await db
      .select({ syncedAt: discordEvents.syncedAt })
      .from(discordEvents)
      .orderBy(desc(discordEvents.syncedAt))
      .limit(1);

    return res.status(200).json({
      ok: true,
      // À venir : triés du plus proche au plus lointain.
      upcoming: all
        .filter((e) => !e.isPast && !e.isCancelled)
        .sort((a, b) => +new Date(a.startAt) - +new Date(b.startAt)),
      // Passés : les plus récents d'abord, limités pour ne pas noyer la page.
      past: all.filter((e) => e.isPast || e.isCancelled).slice(0, 12),
      total: all.length,
      lastSyncAt: lastSyncRow?.syncedAt ?? null,
      isAdmin: ctx.isAdmin,
      configured: Boolean(process.env.DISCORD_BOT_TOKEN && process.env.DISCORD_GUILD_ID),
    });
  } catch (err: any) {
    console.error('[events]', err);
    return res.status(500).json({ error: err.message });
  }
}

/** Synchronise les événements Discord en base. Réservé à l'admin. */
async function sync(req: any, res: any) {
  const ctx = await requireAdmin(req, res);
  if (!ctx) return;

  try {
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
    if (events.length > 0) {
      const keep = events.map((e) => e.id);
      await db.execute(sql`
        DELETE FROM discord_events
        WHERE id NOT IN (${sql.join(
          keep.map((id) => sql`${id}`),
          sql`, `,
        )})
      `);
    } else {
      // Aucun événement renvoyé : on ne supprime rien, ça peut être un
      // serveur sans événement ou un problème de permission transitoire.
    }

    return res.status(200).json({
      ok: true,
      synced: events.length,
      syncedAt: now,
    });
  } catch (err: any) {
    console.error('[events/sync]', err);
    return res.status(500).json({ error: err.message });
  }
}
