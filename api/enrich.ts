import type { VercelRequest, VercelResponse } from '@vercel/node';
import { runEnrich } from '../lib/enrich-worker.ts';
import { requireAccess } from '../lib/access.ts';

/**
 * POST /api/enrich — avance l'enrichissement tout de suite.
 *
 * L'enrichissement est AUTOMATIQUE (fonction planifiée Netlify). Cette route
 * sert à l'accélérer quand un membre vient de synchroniser sa ludothèque : la
 * page Profil l'appelle en boucle tant qu'il reste des jeux à identifier.
 *
 * Authentification obligatoire : sans elle, n'importe qui pourrait consommer
 * les quotas des API externes.
 *
 * Budget volontairement court (6 s) : les fonctions synchrones Netlify sont
 * limitées à 10 s sur le plan gratuit. La boucle côté navigateur enchaîne
 * plusieurs appels, ce qui donne un débit bien plus élevé qu'un seul gros lot.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const ctx = await requireAccess(req, res);
  if (!ctx) return;

  try {
    const result = await runEnrich({ budgetMs: 6_000, withPrices: true });
    return res.status(200).json({ ok: true, ...result });
  } catch (err: any) {
    console.error('[enrich]', err);
    return res.status(500).json({ error: err.message });
  }
}
