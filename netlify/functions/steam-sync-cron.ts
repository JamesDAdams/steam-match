import type { Config } from '@netlify/functions';
import { getSettings, updateSettings } from '../../lib/settings.ts';
import { runSteamSync } from '../../lib/steam-sync-worker.ts';

/**
 * Rafraîchissement automatique des ludothèques Steam.
 *
 * POURQUOI TOUTES LES 15 MINUTES ET PAS TOUTES LES HEURES :
 * l'intervalle réel est un réglage (page admin, 1 h par défaut). Netlify ne
 * permet pas de modifier un planning à chaud : la fonction se réveille donc
 * souvent, lit le réglage, et ne travaille que si l'intervalle est écoulé.
 * Un tick court évite aussi qu'un grand nombre de comptes ne soit jamais
 * rattrapé — le worker traite les plus anciens d'abord, dans un budget de 8 s.
 *
 * POURQUOI 8 SECONDES : les fonctions planifiées sont coupées à 10 s sur les
 * plans sans marge. Le worker s'arrête de lui-même avant, pour enregistrer son
 * état et laisser la suite au passage suivant.
 */
export default async () => {
  const started = Date.now();

  try {
    const settings = await getSettings();

    if (!settings.steamSyncEnabled) {
      return json({ ok: true, skipped: 'disabled' });
    }

    const intervalMs = settings.steamSyncIntervalHours * 3_600_000;
    const last = settings.lastSteamSyncAt?.getTime() ?? 0;
    if (last > 0 && Date.now() - last < intervalMs) {
      return json({
        ok: true,
        skipped: 'interval',
        nextAt: new Date(last + intervalMs).toISOString(),
      });
    }

    const report = await runSteamSync({ budgetMs: 8_000 });

    await updateSettings({
      lastSteamSyncAt: new Date(),
      lastSteamSyncResult:
        `${report.handled} compte(s) synchronisé(s)` +
        (report.failed ? `, ${report.failed} en échec` : '') +
        (report.remaining ? `, ${report.remaining} en attente` : '') +
        ` — ${report.durationMs} ms`,
    });

    console.log('[cron steam]', report.handled, 'ok /', report.failed, 'ko /', report.remaining, 'restants');
    return json({ ok: true, ...report, durationMs: Date.now() - started });
  } catch (err: any) {
    console.error('[cron steam] échec', err);
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
  schedule: '*/15 * * * *',
};
