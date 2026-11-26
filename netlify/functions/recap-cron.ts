import type { Config } from '@netlify/functions';
import { runRecapIfDue } from '../../lib/recap.ts';

/**
 * Récap' du groupe : régénération de l'image publiée.
 *
 * POURQUOI TOUTES LES HEURES : Netlify ne permet pas de modifier un planning
 * à chaud, et la fréquence est un réglage admin (tous les jours à 6 h par
 * défaut). La fonction se réveille à chaque heure, lit le réglage, et ne
 * travaille que si le délai est écoulé. Le contrôle du délai est fait dans
 * runRecapIfDue, pas ici : le chemin manuel (bouton admin) le réutilise.
 */
export default async () => {
  try {
    const result = await runRecapIfDue();

    if (!result.ran) {
      return json({ ok: true, skipped: result.reason });
    }

    console.log(
      '[cron récap]',
      result.stats?.days,
      'jours,',
      result.stats?.top.length,
      'jeux au top',
    );
    return json({
      ok: true,
      days: result.stats?.days,
      mode: result.stats?.mode,
      top: result.stats?.top.slice(0, 5).map((g) => g.name),
      launched: result.stats?.launched.length,
    });
  } catch (err: any) {
    console.error('[cron récap] échec', err);
    return json({ ok: false, error: err?.message }, 500);
  }
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export const config: Config = {
  // Décalé de 5 minutes : évite de concurrencer les autres tâches de l'heure.
  schedule: '5 * * * *',
};
