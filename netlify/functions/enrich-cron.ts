import type { Config } from '@netlify/functions';
import { runEnrich } from '../../lib/enrich-worker.ts';

/**
 * Enrichissement automatique et périodique.
 *
 * POURQUOI CE FICHIER :
 * l'enrichissement (nom, genres, prix) ne doit pas dépendre d'un clic. Cette
 * fonction planifiée Netlify traite la file en arrière-plan, sans intervention.
 *
 * POURQUOI TOUTES LES 2 MINUTES :
 * le worker est désormais parallèle et limité par les API (Steam ~350 ms,
 * CheapShark 800 ms entre deux appels), pas par sa propre latence. Un passage
 * de 20 s traite donc beaucoup plus de jeux qu'avant. Un intervalle de 2 min
 * évite les passages à vide tout en restant économe en invocations : quand la
 * file est vide, la fonction rend la main en quelques centaines de ms.
 *
 * Le budget de 20 s reste sous la limite d'exécution des fonctions planifiées.
 */
export default async () => {
  const started = Date.now();

  try {
    const result = await runEnrich({ budgetMs: 20_000, withPrices: true });

    console.log('[cron enrich]', {
      ...result,
      durationMs: Date.now() - started,
    });

    return new Response(
      JSON.stringify({ ok: true, ...result, durationMs: Date.now() - started }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  } catch (err: any) {
    console.error('[cron enrich] échec', err);
    return new Response(JSON.stringify({ ok: false, error: err?.message }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }
};

export const config: Config = {
  // Toutes les 2 minutes (Netlify : granularité d'une minute).
  schedule: '*/2 * * * *',
};
