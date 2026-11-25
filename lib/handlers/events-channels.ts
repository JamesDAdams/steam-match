import { requireAdmin } from '../access.ts';
import { isBotConfigured, listEventChannels } from '../discord-bot.ts';

/**
 * GET /api/events/channels — salons vocaux et scènes du serveur.
 *
 * Sert à alimenter le sélecteur du modal « Créer un événement ». Réservé à
 * l'admin puisque la création l'est aussi.
 *
 * On répond toujours 200 : une liste vide avec un message d'erreur est plus
 * simple à afficher qu'un 502, et ce n'est qu'une donnée d'assistance.
 */
export default async function handler(req: any, res: any) {
  if ((req.method || 'GET').toUpperCase() !== 'GET') {
    return res.status(405).json({ error: `Méthode ${req.method} non supportée.` });
  }

  const ctx = await requireAdmin(req, res);
  if (!ctx) return;

  if (!isBotConfigured()) {
    return res.status(200).json({
      ok: true,
      configured: false,
      channels: [],
      error: null,
    });
  }

  try {
    const channels = await listEventChannels();
    return res.status(200).json({
      ok: true,
      configured: true,
      channels: channels.map((c) => ({ id: c.id, name: c.name, type: c.type })),
      error: null,
    });
  } catch (err: any) {
    console.error('[events/channels]', err);
    return res.status(200).json({
      ok: true,
      configured: true,
      channels: [],
      error: err.message,
    });
  }
}
