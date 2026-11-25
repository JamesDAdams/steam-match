import { getDb } from '../../db/index.ts';
import { discordEvents } from '../../db/schema.ts';
import { eq } from 'drizzle-orm';
import { requireAdmin } from '../access.ts';
import { deleteScheduledEvent, isBotConfigured } from '../discord-bot.ts';

/**
 * POST /api/events/delete — supprime un événement programmé.
 *
 * Réservé à l'administrateur : supprimer un rendez-vous engage tout le serveur.
 *
 * Ordre volontaire : Discord d'abord, base ensuite. Si Discord refuse, on ne
 * touche pas à la base — l'événement reste visible et l'admin peut réessayer.
 * L'inverse laisserait une ligne en base pour un événement encore vivant sur
 * Discord, donc invisible après le prochain « Synchroniser ».
 */
export default async function handler(req: any, res: any) {
  if ((req.method || 'GET').toUpperCase() !== 'POST') {
    return res.status(405).json({ error: `Méthode ${req.method} non supportée.` });
  }

  const ctx = await requireAdmin(req, res);
  if (!ctx) return;

  if (!isBotConfigured()) {
    return res.status(503).json({
      error:
        'Impossible de supprimer : le bot Discord n’est pas configuré. ' +
        'Renseigne DISCORD_BOT_TOKEN et DISCORD_GUILD_ID, puis redéploie.',
      code: 'BOT_NOT_CONFIGURED',
    });
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const id = typeof body.id === 'string' ? body.id.trim() : String(body.id ?? '').trim();

  // Un identifiant d'événement Discord est un snowflake de 17 à 20 chiffres.
  if (!/^\d{17,20}$/.test(id)) {
    return res.status(400).json({ error: 'Identifiant d’événement invalide.' });
  }

  try {
    await deleteScheduledEvent(id);
  } catch (err: any) {
    console.error('[events/delete]', err);
    return res.status(502).json({ error: err.message });
  }

  // On retire la ligne même si Discord a répondu 404 (déjà supprimé) : dans
  // les deux cas, l'événement ne doit plus apparaître sur le site.
  let existed = false;
  try {
    const db = getDb();
    const removed = await db
      .delete(discordEvents)
      .where(eq(discordEvents.id, id))
      .returning({ id: discordEvents.id });
    existed = removed.length > 0;
  } catch (err: any) {
    // Suppression Discord réussie mais nettoyage local en échec : on le dit,
    // sans prétendre que tout va bien.
    console.error('[events/delete] nettoyage base', err);
    return res.status(500).json({
      error:
        'L’événement a été supprimé sur Discord, mais le site n’a pas pu ' +
        'mettre à jour sa copie. Clique sur « Synchroniser » pour corriger.',
      code: 'DB_CLEANUP_FAILED',
    });
  }

  return res.status(200).json({ ok: true, deleted: id, existed });
}
