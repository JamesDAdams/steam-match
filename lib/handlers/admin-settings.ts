import { requireAdmin } from '../access.ts';
import {
  getSettings,
  updateSettings,
  STEAM_SYNC_MAX_HOURS,
  STEAM_SYNC_MIN_HOURS,
} from '../settings.ts';
import { countTrackedAccounts, runSteamSync } from '../steam-sync-worker.ts';
import { runReleaseNotifications, todayInParis } from '../release-notifier.ts';
import { listTextChannels } from '../discord-bot.ts';

/**
 * /api/admin/settings — réglages de la synchronisation Steam.
 *
 * GET  : réglages courants + nombre de comptes suivis.
 * POST : { enabled?, intervalHours? } pour modifier,
 *        ou { action: 'run' } pour lancer tout de suite un passage.
 *
 * Réservé à l'admin : ces réglages déclenchent des appels à l'API Steam pour
 * tout le monde, ils ne sont pas une préférence personnelle.
 */
export default async function handler(req: any, res: any) {
  const ctx = await requireAdmin(req, res);
  if (!ctx) return;

  const method = (req.method || 'GET').toUpperCase();

  try {
    if (method === 'GET') {
      const [settings, counts, channels] = await Promise.all([
        getSettings(),
        countTrackedAccounts(),
        listTextChannels().catch(() => []),
      ]);
      return res.status(200).json({
        ok: true,
        settings,
        accounts: counts,
        bounds: { min: STEAM_SYNC_MIN_HOURS, max: STEAM_SYNC_MAX_HOURS },
        today: todayInParis(),
        // Sélecteur de salon dans l'admin : plus simple qu'un identifiant à
        // recopier, et évite les erreurs de frappe.
        channels,
      });
    }

    if (method === 'POST') {
      const body = (req.body ?? {}) as Record<string, unknown>;

      if (body.action === 'run-releases') {
        const report = await runReleaseNotifications({ force: true });
        return res.status(200).json({ ok: true, report });
      }

      if (body.action === 'run') {
        const report = await runSteamSync({ budgetMs: 8_000 });
        await updateSettings({
          lastSteamSyncAt: new Date(),
          lastSteamSyncResult:
            `${report.handled} compte(s) synchronisé(s)` +
            (report.failed ? `, ${report.failed} en échec` : '') +
            (report.remaining ? `, ${report.remaining} en attente` : ''),
        });
        return res.status(200).json({ ok: true, report });
      }

      const patch: {
        recommendationsEnabled?: boolean;
        steamSyncEnabled?: boolean;
        steamSyncIntervalHours?: number;
        releaseNotifyEnabled?: boolean;
        releaseNotifyHour?: number;
        releaseChannelId?: string | null;
      } = {};

      if (typeof body.recommendationsEnabled === 'boolean') {
        patch.recommendationsEnabled = body.recommendationsEnabled;
      }
      if (typeof body.releaseNotifyEnabled === 'boolean') {
        patch.releaseNotifyEnabled = body.releaseNotifyEnabled;
      }
      if (body.releaseNotifyHour !== undefined && body.releaseNotifyHour !== null) {
        const hour = Number(body.releaseNotifyHour);
        if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
          return res.status(400).json({ error: 'Heure invalide (0 à 23).' });
        }
        patch.releaseNotifyHour = hour;
      }
      if (body.releaseChannelId !== undefined) {
        const raw = String(body.releaseChannelId ?? '').trim();
        if (raw && !/^\d{17,20}$/.test(raw)) {
          return res.status(400).json({ error: 'Identifiant de salon Discord invalide.' });
        }
        patch.releaseChannelId = raw || null;
      }

      if (typeof body.enabled === 'boolean') {
        patch.steamSyncEnabled = body.enabled;
      }
      if (body.intervalHours !== undefined && body.intervalHours !== null) {
        const hours = Number(body.intervalHours);
        if (!Number.isFinite(hours)) {
          return res.status(400).json({ error: 'Intervalle invalide.' });
        }
        if (hours < STEAM_SYNC_MIN_HOURS || hours > STEAM_SYNC_MAX_HOURS) {
          return res.status(400).json({
            error: `L’intervalle doit être compris entre ${STEAM_SYNC_MIN_HOURS} et ${STEAM_SYNC_MAX_HOURS} heures.`,
          });
        }
        patch.steamSyncIntervalHours = hours;
      }

      if (Object.keys(patch).length === 0) {
        return res.status(400).json({ error: 'Aucun réglage à modifier.' });
      }

      const settings = await updateSettings(patch);
      return res.status(200).json({ ok: true, settings });
    }

    return res.status(405).json({ error: `Méthode ${method} non supportée.` });
  } catch (err: any) {
    console.error('[admin/settings]', err);
    return res.status(500).json({ error: err.message });
  }
}
