import { optionalAccess } from '../access.ts';
import { getSettings } from '../settings.ts';
import { generateRecapImage, getStoredRecap, redactRecapStats } from '../recap.ts';

/**
 * GET /api/recap — données du récap' du groupe.
 *
 * DEUX NIVEAUX DE LECTURE :
 *   1. visiteur non connecté — autorisé si l'admin a coché « page publique ».
 *      Les pseudos sont alors RETIRÉS côté serveur (pas seulement masqués en
 *      CSS) : le JSON ne les contient pas, un curieux ne peut pas les lire
 *      dans l'onglet réseau. Il ne reste que le nombre de joueurs ;
 *   2. membre connecté — les pseudos sont inclus si le réglage l'autorise.
 *
 * Si l'image n'existe pas encore (première visite après activation), on la
 * construit à la volée : sans ça, la page resterait vide jusqu'au prochain
 * passage du cron.
 */
export default async function handler(req: any, res: any) {
  if ((req.method || 'GET').toUpperCase() !== 'GET') {
    return res.status(405).json({ error: `Méthode ${req.method} non supportée.` });
  }

  try {
    const ctx = await optionalAccess(req);
    const settings = await getSettings();
    const publicPage = settings.recapEnabled && settings.recapPublicPage;

    // Récap' désactivé : seul l'admin garde l'aperçu.
    if (!settings.recapEnabled) {
      if (!ctx?.isAdmin) {
        return res.status(404).json({ error: 'Le récap’ est désactivé.' });
      }
    }

    // Page non publique : il faut être connecté ET autorisé.
    if (!ctx && !publicPage) {
      return res.status(401).json({
        error: 'Connecte-toi pour voir le récap’ du groupe.',
      });
    }

    let stored = await getStoredRecap();

    // L'image doit correspondre aux réglages courants (fenêtre, pseudos) et,
    // pour la page publique, exister dans sa variante anonyme.
    const stale =
      !stored ||
      stored.windowDays !== settings.recapDays ||
      stored.showNames !== settings.recapShowNames ||
      (publicPage && settings.recapShowNames && !stored.svgPublic);

    if (stale && settings.recapEnabled) {
      await generateRecapImage(settings.recapDays);
      stored = await getStoredRecap();
    }

    const stats = stored?.stats ?? null;
    const anonymous = !ctx;
    // Pseudos masqués par l'admin : on les retire aussi du JSON des membres.
    // Les cacher uniquement à l'écran laisserait les noms dans la réponse.
    const stripNames = anonymous || !settings.recapShowNames;

    return res.status(200).json({
      ok: true,
      enabled: settings.recapEnabled,
      /** Le visiteur est-il anonyme ? (pseudos masqués dans ce cas) */
      anonymous,
      /** Faut-il afficher les pseudos ? Toujours faux pour un anonyme. */
      showNames: anonymous ? false : settings.recapShowNames,
      /** Les membres voient-ils les pseudos ? (l'anonyme peut être invité) */
      namesAvailable: settings.recapShowNames,
      publicPage: settings.recapPublicPage,
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
      stats: stats ? (stripNames ? redactRecapStats(stats) : stats) : null,
    });
  } catch (err: any) {
    console.error('[recap]', err);
    return res.status(500).json({ error: err.message });
  }
}
