import { requireAccess } from '../access.ts';
import { getSettings } from '../settings.ts';
import { generateRecapImage, getStoredRecap } from '../recap.ts';

/**
 * GET /api/recap/image — l'image du récap', en SVG.
 *
 * POURQUOI SVG ET PAS PNG : la fonction serverless n'a aucune bibliothèque de
 * rasterisation (ni sharp, ni canvas). Le SVG est produit directement, pèse
 * quelques centaines de Ko, reste net à toutes les tailles, et la page sait le
 * convertir en PNG côté navigateur pour un partage sur Discord.
 *
 * L'image est stockée (table recap_images) : on ne refait ni l'agrégation SQL
 * ni le téléchargement des jaquettes à chaque affichage.
 */
export default async function handler(req: any, res: any) {
  const ctx = await requireAccess(req, res);
  if (!ctx) return;

  if ((req.method || 'GET').toUpperCase() !== 'GET') {
    return res.status(405).json({ error: `Méthode ${req.method} non supportée.` });
  }

  try {
    const settings = await getSettings();
    if (!settings.recapEnabled && !ctx.isAdmin) {
      return res.status(404).json({ error: 'Le récap’ est désactivé.' });
    }

    let stored = await getStoredRecap();
    if (!stored) {
      await generateRecapImage(settings.recapDays);
      stored = await getStoredRecap();
    }
    if (!stored) {
      return res.status(404).json({ error: 'Aucune image générée pour le moment.' });
    }

    const etag = `"recap-${stored.generatedAt.getTime()}"`;
    const inm = String(req.headers['if-none-match'] ?? '');
    if (inm && inm === etag) {
      res.status(304).setHeader('etag', etag);
      return res.send('');
    }

    res.setHeader('content-type', 'image/svg+xml; charset=utf-8');
    res.setHeader('cache-control', 'private, max-age=600');
    res.setHeader('etag', etag);
    return res.send(stored.svg);
  } catch (err: any) {
    console.error('[recap/image]', err);
    return res.status(500).json({ error: err.message });
  }
}
