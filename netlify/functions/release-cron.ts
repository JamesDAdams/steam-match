import type { Config } from '@netlify/functions';
import { getSettings, updateSettings } from '../../lib/settings.ts';
import { runReleaseNotifications, todayInParis } from '../../lib/release-notifier.ts';

/**
 * Rappels Discord des sorties de jeux.
 *
 * POURQUOI TOUTES LES HEURES ET PAS À 6 H PRÉCISES :
 * Netlify ne permet pas de modifier un planning à chaud, et l'heure d'envoi est
 * un réglage (6 h par défaut). La fonction se réveille donc à chaque heure,
 * compare avec le réglage, et ne travaille qu'une fois par jour.
 *
 * La déduplication (table release_notifications) rend les réveils répétés
 * inoffensifs : même si l'heure est atteinte deux fois, personne ne reçoit
 * deux messages.
 */
export default async () => {
  try {
    const settings = await getSettings();

    if (!settings.releaseNotifyEnabled) {
      return json({ ok: true, skipped: 'disabled' });
    }

    const parisHour = Number(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Paris',
        hour: '2-digit',
        hour12: false,
      }).format(new Date()),
    );

    if (parisHour < settings.releaseNotifyHour) {
      return json({ ok: true, skipped: 'before-hour', parisHour, target: settings.releaseNotifyHour });
    }

    // Déjà exécuté aujourd'hui ? On compare la date du dernier envoi.
    const day = todayInParis();
    const last = settings.lastReleaseNotifyAt;
    if (last && todayInParis(new Date(last)) === day) {
      return json({ ok: true, skipped: 'already-done', day });
    }

    const report = await runReleaseNotifications({ day });
    console.log('[cron sorties]', report);
    return json({ ...report });
  } catch (err: any) {
    console.error('[cron sorties] échec', err);
    await updateSettings({ lastReleaseNotifyAt: new Date() }).catch(() => undefined);
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
  // Toutes les heures : l'heure exacte est pilotée par le réglage admin.
  schedule: '0 * * * *',
};
