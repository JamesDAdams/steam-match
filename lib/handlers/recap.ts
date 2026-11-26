import { requireAccess } from '../access.ts';
import { getSettings } from '../settings.ts';
import { generateRecapImage, getStoredRecap } from '../recap.ts';

/**
 * GET /api/recap — données du récap' du groupe.
 *
 * Renvoie les chiffres (les plus joués, jeux lancés) et la date de génération
 * de l'image. La page affiche l'image séparément (/api/recap/image), ce qui
 * permet de la mettre en cache sans recharger les statistiques.
 *
 * Si l'image n'existe pas encore (première visite après activation), on la
 * construit à la volée : sans ça, la page resterait vide jusqu'au prochain
 * passage du cron.
 */
export default async function handler(req: any, res: any) {
  const ctx = await requireAccess(req, res);
  if (!ctx) return;

  if ((req.method || 'GET').toUpperCase() !== 'GET') {
    return res.status(405).json({ error: `Méthode ${req.method} non supportée.` });
  }

  try {
    const settings = await getSettings();
    let stored = await getStoredRecap();

    if (!stored && settings.recapEnabled) {
      await generateRecapImage(settings.recapDays);
      stored = await getStoredRecap();
    }

    // Le réglage a changé depuis la dernière génération (fenêtre, activation) :
    // on régénère pour que l'image corresponde à ce qui est configuré.
    if (stored && settings.recapEnabled && stored.windowDays !== settings.recapDays) {
      await generateRecapImage(settings.recapDays);
      stored = await getStoredRecap();
    }

    return res.status(200).json({
      ok: true,
      enabled: settings.recapEnabled,
      days: settings.recapDays,
      refreshHours: settings.recapRefreshHours,
      hour: settings.recapHour,
      lastRecapAt: settings.lastRecapAt,
      image: stored
        ? {
            generatedAt: stored.generatedAt,
            windowDays: stored.windowDays,
            mode: stored.mode,
          }
        : null,
      stats: stored?.stats ?? null,
    });
  } catch (err: any) {
    console.error('[recap]', err);
    return res.status(500).json({ error: err.message });
  }
}
