import type { Config } from '@netlify/functions';
import { runEnrich } from '../../lib/enrich-worker.ts';

/**
 * Enrichissement automatique et périodique.
 *
 * POURQUOI CE FICHIER :
 * l'enrichissement (nom, genres, prix) ne doit pas dépendre d'un clic. Cette
 * fonction planifiée Netlify traite la file en arrière-plan, sans intervention.
 *
 * POURQUOI TOUTES LES MINUTES :
 * le worker est parallèle et limité par les API (Steam ~350 ms, CheapShark
 * 800 ms entre deux appels), pas par sa propre latence. Un passage traite donc
 * beaucoup plus de jeux qu'avant. Quand la file est vide, la fonction rend la
 * main en quelques centaines de ms : le coût d'un intervalle court est
 * négligeable, alors que le gain est réel tant qu'il reste des jeux.
 *
 * POURQUOI 9 SECONDES :
 * les fonctions planifiées sont tuées à 10 s sur les plans sans marge
 * d'exécution. Un budget plus long n'apportait rien et laissait des
 * réclamations orphelines à chaque passage.
 */
export default async () => {
  const started = Date.now();

  try {
    const result = await runEnrich({ budgetMs: 9_000, withPrices: true });

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
  // Toutes les minutes (granularité minimale de Netlify).
  schedule: '* * * * *',
};
