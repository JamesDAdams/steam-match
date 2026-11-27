import { optionalAccess } from '../access.ts';
import { getReleaseCalendar } from '../releases.ts';
import { getSettings } from '../settings.ts';

/**
 * GET /api/releases — calendrier des sorties du groupe.
 *
 * Construit à partir des wishlists des membres et des dates de sortie du
 * Store : c'est l'équivalent du « calendrier personnel » de Steam, mais
 * partagé par tout le serveur (et lisible sans session Steam).
 */
export default async function handler(req: any, res: any) {
  // Page PUBLIQUE (réglable dans l'admin) : un visiteur non connecté voit le
  // calendrier, mais jamais les pseudos — seulement le nombre de membres.
  const ctx = await optionalAccess(req);

  if ((req.method || 'GET').toUpperCase() !== 'GET') {
    return res.status(405).json({ error: `Méthode ${req.method} non supportée.` });
  }

  try {
    const settings = await getSettings();
    const scope = String(req.query?.scope ?? '') === 'mine' ? 'mine' : 'all';

    if (!ctx) {
      // « Mes sorties » est personnel : connexion obligatoire.
      if (scope === 'mine') {
        return res.status(401).json({ error: 'Connecte-toi pour voir tes sorties.' });
      }
      if (!settings.releasePublicPage) {
        return res.status(401).json({ error: 'Connecte-toi pour voir le calendrier des sorties.' });
      }
    }

    if (scope === 'mine' && !ctx?.steamid) {
      return res.status(200).json({
        ok: true,
        scope,
        hasSteam: false,
        upcoming: [],
        recent: [],
        later: [],
        undated: [],
        total: 0,
      });
    }

    const calendar = await getReleaseCalendar(
      scope === 'mine' ? { steamid: ctx?.steamid } : {},
    );

    // Visiteur non connecté : on retire les identités, on garde les compteurs.
    if (!ctx) {
      for (const list of [calendar.upcoming, calendar.recent, calendar.later, calendar.undated]) {
        for (const entry of list) entry.wishers = [];
      }
    }

    return res.status(200).json({
      ok: true,
      scope,
      viewer: ctx ? 'member' : 'anonymous',
      anonymous: !ctx,
      hasSteam: Boolean(ctx?.steamid),
      ...calendar,
      total: calendar.upcoming.length + calendar.undated.length + calendar.recent.length,
    });
  } catch (err: any) {
    console.error('[releases]', err);
    return res.status(500).json({ error: err.message });
  }
}
