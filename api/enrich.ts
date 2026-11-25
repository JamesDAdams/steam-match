import type { VercelRequest, VercelResponse } from '@vercel/node';
import { runEnrichBatch } from '../lib/enrich-worker.ts';

/**
 * POST /api/enrich — enrichissement manuel.
 *
 * L'enrichissement est désormais AUTOMATIQUE (fonction planifiée Netlify).
 * Cette route ne sert plus au quotidien : elle reste pour forcer une reprise
 * après un blocage de quota, ou pour amorcer une base fraîche.
 */
export default async function handler(_req: VercelRequest, res: VercelResponse) {
  try {
    const result = await runEnrichBatch(10, true);
    return res.status(200).json({ ok: true, ...result });
  } catch (err: any) {
    console.error('[enrich]', err);
    return res.status(500).json({ error: err.message });
  }
}
