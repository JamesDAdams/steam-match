import type { Config } from '@netlify/functions';
import { syncDueExternalAccounts } from '../../lib/external-sync.ts';

/**
 * Rafraîchissement des ludothèques GOG / Epic.
 *
 * Pourquoi toutes les heures : les comptes liés changent rarement (un achat de
 * temps en temps), et chaque synchronisation coûte plusieurs appels aux
 * services GOG/Epic. On ne retraite donc un compte que s'il date de plus de
 * 24 h, et on étale le travail (budget de 8 s par passage).
 */
export default async () => {
  try {
    const report = await syncDueExternalAccounts(8_000);
    console.log('[cron externe]', report);
    return json({ ok: true, ...report });
  } catch (err: any) {
    console.error('[cron externe] échec', err);
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
  // Décalé de 10 minutes pour ne pas concurrencer les autres tâches.
  schedule: '10 * * * *',
};
