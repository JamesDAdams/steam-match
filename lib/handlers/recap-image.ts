import { requireAccess } from '../access.ts';
import { getSettings } from '../settings.ts';
import { generateRecapImage, getStoredRecap, isValidRecapKey } from '../recap.ts';

/**
 * GET /api/recap/image — l'image du récap', en SVG.
 *
 * TROIS PORTES D'ENTRÉE :
 *   1. `?variant=public` — la variante SANS pseudos. Aucune session requise :
 *      c'est une image publique, mise en cache par le CDN, qui ne contient
 *      aucun pseudo (partage hors Discord, page publique) ;
 *   2. session valide (membre) — la variante complète, avec les pseudos si le
 *      réglage l'autorise ;
 *   3. lien signé `?k=…` — c'est celui que le bot poste dans Discord. Discord
 *      récupère les images sans cookie : sans cette signature, l'aperçu du
 *      message serait vide. La signature change à chaque régénération.
 *
 * POURQUOI DEUX VARIANTES : une image est un objet unique, impossible de
 * masquer les pseudos à l'affichage. Sans variante dédiée, publier la page
 * reviendrait à publier les pseudos dans le SVG.
 *
 * POURQUOI SVG ET PAS PNG : la fonction serverless n'a aucune bibliothèque de
 * rasterisation (ni sharp, ni canvas). Le CDN d'images de Netlify fait la
 * conversion en PNG pour l'aperçu Discord (`/.netlify/images?...&fm=png`).
 */
export default async function handler(req: any, res: any) {
  if ((req.method || 'GET').toUpperCase() !== 'GET') {
    return res.status(405).json({ error: `Méthode ${req.method} non supportée.` });
  }

  try {
    const wantsPublic = String(req.query?.variant ?? '') === 'public';
    let stored = await getStoredRecap();

    if (wantsPublic) {
      const settings = await getSettings();
      if (!settings.recapEnabled || !settings.recapPublicPage) {
        return res.status(404).json({ error: 'Le récap’ n’est pas public.' });
      }

      // Variante anonyme absente (image générée avant l'ouverture au public) :
      // on régénère une fois pour l'obtenir.
      if (!stored || (settings.recapShowNames && !stored.svgPublic)) {
        await generateRecapImage(settings.recapDays);
        stored = await getStoredRecap();
      }
      if (!stored) {
        return res.status(404).json({ error: 'Aucune image générée pour le moment.' });
      }

      const etag = `"recap-public-${stored.generatedAt.getTime()}"`;
      const inm = String(req.headers['if-none-match'] ?? '');
      if (inm && inm === etag) {
        res.status(304).setHeader('etag', etag);
        return res.send('');
      }

      res.setHeader('content-type', 'image/svg+xml; charset=utf-8');
      // Cachable par le CDN : le contenu ne dépend d'aucune session.
      res.setHeader('cache-control', 'public, max-age=600');
      res.setHeader('etag', etag);
      return res.send(stored.svgPublic ?? stored.svg);
    }

    const key = typeof req.query?.k === 'string' ? req.query.k : '';
    const signed = stored ? isValidRecapKey(key, stored.generatedAt) : false;

    // Accès par session : obligatoire hors lien signé.
    let isAdmin = false;
    if (!signed) {
      const ctx = await requireAccess(req, res);
      if (!ctx) return;
      isAdmin = Boolean(ctx.isAdmin);

      const settings = await getSettings();
      if (!settings.recapEnabled && !isAdmin) {
        return res.status(404).json({ error: 'Le récap’ est désactivé.' });
      }

      if (!stored) {
        await generateRecapImage(settings.recapDays);
        stored = await getStoredRecap();
      }
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
    // Un lien signé peut être mis en cache par le CDN (c'est ce qui permet à
    // Netlify de convertir et servir le PNG de l'aperçu Discord).
    res.setHeader('cache-control', signed ? 'public, max-age=600' : 'private, max-age=600');
    res.setHeader('etag', etag);
    return res.send(stored.svg);
  } catch (err: any) {
    console.error('[recap/image]', err);
    return res.status(500).json({ error: err.message });
  }
}
