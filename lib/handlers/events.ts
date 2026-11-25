import { getDb } from '../../db/index.ts';
import { discordEvents } from '../../db/schema.ts';
import { desc } from 'drizzle-orm';
import { requireAccess, requireAdmin } from '../access.ts';
import { isBotConfigured, inviteUrl } from '../discord-bot.ts';
import { syncDiscordEvents, syncDiscordEventsIfStale } from '../events-sync.ts';

/**
 * GET  /api/events  → événements à venir et passés (membres autorisés)
 * POST /api/events  → synchronise depuis Discord (admin uniquement)
 *
 * La CRÉATION d'un événement depuis le site vit dans events-create.ts, et la
 * liste des salons vocaux dans events-channels.ts : autant de routes distinctes
 * pour garder chaque handler lisible.
 *
 * Ces handlers vivent dans lib/handlers/ et non dans api/ : le plan Hobby de
 * Vercel plafonne à 12 fonctions, et api/ en compte déjà 12. Le routeur Netlify
 * les expose via la fonction catch-all, sans consommer de place.
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
    // Discord reste la source de vérité : on rafraîchit la base avant de lire,
    // au plus une fois toutes les 45 s. Sans ça, un événement supprimé sur
    // Discord continuait d'apparaître sur le site.
    let syncInfo: { skipped: boolean; synced?: number; error?: string } | null = null;
    if (isBotConfigured()) {
      try {
        syncInfo = await syncDiscordEventsIfStale();
      } catch (err: any) {
        // On n'empêche pas l'affichage, mais on remonte la raison : sans elle
        // un échec de synchronisation est invisible et ressemble à un bug de
        // suppression.
        syncInfo = { skipped: false, error: err?.message ?? String(err) };
        console.warn('[events] synchronisation de fond ignorée :', err?.message);
      }
    }

    const db = getDb();
    const now = new Date();

    const rows = await db
      .select()
      .from(discordEvents)
      .orderBy(desc(discordEvents.scheduledStartAt));

    const toDto = (e: (typeof rows)[number]) => ({
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
      // Une liste vide peut simplement signifier « personne », affichée comme
      // telle ; le décompte Discord reste la référence.
      interestedUsers: e.interestedUsers ?? [],
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

    const configured = isBotConfigured();

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
      sync: syncInfo,
      isAdmin: ctx.isAdmin,
      // Le bouton « Créer un événement » n'a de sens que pour un admin avec
      // un bot configuré.
      canCreate: ctx.isAdmin && configured,
      configured,
      inviteUrl: inviteUrl(),
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

  if (!isBotConfigured()) {
    return res.status(503).json({
      error:
        'Le bot Discord n’est pas configuré. Renseigne DISCORD_BOT_TOKEN et ' +
        'DISCORD_GUILD_ID, puis redéploie.',
      code: 'BOT_NOT_CONFIGURED',
    });
  }

  try {
    const { synced, syncedAt } = await syncDiscordEvents();
    return res.status(200).json({ ok: true, synced, syncedAt });
  } catch (err: any) {
    console.error('[events/sync]', err);
    return res.status(502).json({ error: err.message });
  }
}
