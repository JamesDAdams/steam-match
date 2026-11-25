import { requireAccess } from '../access.ts';
import { getReleaseCalendar } from '../releases.ts';

/**
 * GET /api/releases — calendrier des sorties du groupe.
 *
 * Construit à partir des wishlists des membres et des dates de sortie du
 * Store : c'est l'équivalent du « calendrier personnel » de Steam, mais
 * partagé par tout le serveur (et lisible sans session Steam).
 */
export default async function handler(req: any, res: any) {
  const ctx = await requireAccess(req, res);
  if (!ctx) return;

  if ((req.method || 'GET').toUpperCase() !== 'GET') {
    return res.status(405).json({ error: `Méthode ${req.method} non supportée.` });
  }

  try {
    const calendar = await getReleaseCalendar();
    return res.status(200).json({
      ok: true,
      ...calendar,
      total: calendar.upcoming.length + calendar.undated.length + calendar.recent.length,
    });
  } catch (err: any) {
    console.error('[releases]', err);
    return res.status(500).json({ error: err.message });
  }
}
