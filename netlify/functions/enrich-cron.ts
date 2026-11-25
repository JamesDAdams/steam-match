import type { Config } from '@netlify/functions';
import { runEnrichUntilBudget } from '../../lib/enrich-worker.ts';

/**
 * Enrichissement automatique et périodique.
 *
 * POURQUOI CE FICHIER :
 * l'enrichissement (nom, genres, prix) ne doit pas dépendre d'un clic. Cette
 * fonction planifiée Netlify traite la file en arrière-plan toutes les
 * 10 minutes, sans aucune intervention.
 *
 * POURQUOI 10 MINUTES :
 * SteamSpy et CheapShark tolèrent mal les rafales. Un lot de ~50 jeux toutes
 * les 10 minutes remplit une base de plusieurs centaines de jeux en quelques
 * heures, sans jamais déclencher de blocage. Le budget de temps empêche de
 * dépasser la limite d'exécution de Netlify.
 */
export default async () => {
  const started = Date.now();

  try {
    const result = await runEnrichUntilBudget(
      5, // maximum 5 lots
      10, // de 10 jeux chacun
      20_000, // budget : 20 s (les fonctions planifiées ont plus de marge)
    );

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
  // Toutes les 10 minutes. Netlify utilise une syntaxe cron classique.
  schedule: '*/10 * * * *',
};
