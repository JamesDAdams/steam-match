import { requireAdmin } from '../access.ts';
import {
  getSettings,
  updateSettings,
  RECAP_MAX_DAYS,
  RECAP_MIN_DAYS,
  STEAM_SYNC_MAX_HOURS,
  STEAM_SYNC_MIN_HOURS,
} from '../settings.ts';
import { countTrackedAccounts, runSteamSync } from '../steam-sync-worker.ts';
import { runReleaseNotifications, todayInParis } from '../release-notifier.ts';
import {
  canBotPost,
  getApplicationInfo,
  getApplicationPublicKey,
  getBotIdentity,
  interactionsEndpointUrl,
  listTextChannels,
  setInteractionsEndpointUrl,
} from '../discord-bot.ts';
import { generateRecapImage, getStoredRecap } from '../recap.ts';

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
      const [settings, counts, channels, recap] = await Promise.all([
        getSettings(),
        countTrackedAccounts(),
        listTextChannels().catch(() => []),
        getStoredRecap(),
      ]);

      /**
       * Le salon du récap' est souvent un salon d'annonces en lecture seule :
       * sans ce diagnostic, l'admin clique « Régénérer » et rien n'apparaît
       * sur Discord, sans explication.
       */
      const recapChannel = settings.recapChannelId
        ? await canBotPost(settings.recapChannelId).catch((err) => ({
            canPost: false,
            missing: [] as string[],
            reason: err?.message ?? 'vérification impossible',
          }))
        : null;

      /**
       * Annonces d'événements : même diagnostic que le récap' (le salon peut
       * être en lecture seule), plus l'URL à coller dans le portail Discord —
       * sans elle, les boutons « Je participe » / « Peut-être » ne renvoient
       * jamais rien au site.
       */
      const eventAnnounceChannel = settings.eventAnnounceChannelId
        ? await canBotPost(settings.eventAnnounceChannelId).catch((err) => ({
            canPost: false,
            missing: [] as string[],
            reason: err?.message ?? 'vérification impossible',
          }))
        : null;

      const interactions = {
        url: interactionsEndpointUrl(),
        // Clé publique récupérable : sans elle, aucune signature ne peut être
        // vérifiée, donc aucun clic accepté.
        ready: await getApplicationPublicKey()
          .then((k) => Boolean(k))
          .catch(() => false),
        /**
         * Identité de l'application Discord du bot : c'est CELLE-CI qui doit
         * recevoir l'URL d'interaction. Une confusion entre deux applications
         * (OAuth du site / bot) explique un bouton qui ne répond jamais.
         */
        app: await getBotIdentity()
          .then((b) => ({ id: b.id, name: b.username }))
          .catch(() => null),
        /**
         * URL RÉELLEMENT enregistrée chez Discord. Sans elle, on ne peut pas
         * savoir si le portail pointe bien ici : c'est exactement ce qui a
         * rendu un premier diagnostic difficile.
         */
        declaredUrl: await getApplicationInfo()
          .then((a) => a.interactionsEndpointUrl)
          .catch(() => null),
        /** Dernier appel reçu de Discord (preuve que l'URL pointe bien ici). */
        lastAt: settings.lastInteractionAt,
        lastKind: settings.lastInteractionKind,
      };
      return res.status(200).json({
        ok: true,
        settings,
        accounts: counts,
        bounds: {
          min: STEAM_SYNC_MIN_HOURS,
          max: STEAM_SYNC_MAX_HOURS,
          recapMinDays: RECAP_MIN_DAYS,
          recapMaxDays: RECAP_MAX_DAYS,
        },
        recap: recap
          ? {
              generatedAt: recap.generatedAt,
              windowDays: recap.windowDays,
              mode: recap.mode,
              top: recap.stats?.top.slice(0, 3).map((g) => g.name) ?? [],
              launched: recap.stats?.launched.length ?? 0,
            }
          : null,
        recapChannel,
        eventAnnounceChannel,
        interactions,
        today: todayInParis(),
        // Sélecteur de salon dans l'admin : plus simple qu'un identifiant à
        // recopier, et évite les erreurs de frappe.
        channels,
      });
    }

    if (method === 'POST') {
      const body = (req.body ?? {}) as Record<string, unknown>;

      if (body.action === 'set-interactions-url') {
        const url = interactionsEndpointUrl();
        if (!url) {
          return res
            .status(400)
            .json({ error: 'Adresse publique du site inconnue : impossible de déclarer l’URL.' });
        }
        const result = await setInteractionsEndpointUrl(url);
        if (!result.ok) {
          return res.status(502).json({ error: result.error ?? 'Discord a refusé l’URL.' });
        }
        return res.status(200).json({ ok: true, url: result.url ?? url });
      }

      if (body.action === 'run-releases') {
        const report = await runReleaseNotifications({ force: true });
        return res.status(200).json({ ok: true, report });
      }

      if (body.action === 'run-recap') {
        const { stats, publish } = await generateRecapImage();
        return res.status(200).json({
          ok: true,
          report: {
            days: stats.days,
            mode: stats.mode,
            top: stats.top.slice(0, 5).map((g) => ({ name: g.name, minutes: g.minutes })),
            launched: stats.launched.length,
            players: stats.totals.players,
            discord: publish ?? null,
          },
        });
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
        releasePublicPage?: boolean;
        releaseNotifyHour?: number;
        releaseChannelId?: string | null;
        recapEnabled?: boolean;
        recapPublicPage?: boolean;
        recapShowNames?: boolean;
        recapDays?: number;
        recapRefreshHours?: number;
        recapHour?: number;
        recapChannelId?: string | null;
        recapMessageId?: string | null;
        eventAnnounceChannelId?: string | null;
      } = {};

      if (typeof body.recommendationsEnabled === 'boolean') {
        patch.recommendationsEnabled = body.recommendationsEnabled;
      }
      if (typeof body.releaseNotifyEnabled === 'boolean') {
        patch.releaseNotifyEnabled = body.releaseNotifyEnabled;
      }
      if (typeof body.releasePublicPage === 'boolean') {
        patch.releasePublicPage = body.releasePublicPage;
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

      if (body.recapChannelId !== undefined) {
        const raw = String(body.recapChannelId ?? '').trim();
        if (raw && !/^\d{17,20}$/.test(raw)) {
          return res.status(400).json({ error: 'Identifiant de salon Discord invalide.' });
        }
        patch.recapChannelId = raw || null;
      }

      if (body.eventAnnounceChannelId !== undefined) {
        const raw = String(body.eventAnnounceChannelId ?? '').trim();
        if (raw && !/^\d{17,20}$/.test(raw)) {
          return res.status(400).json({ error: 'Identifiant de salon Discord invalide.' });
        }
        patch.eventAnnounceChannelId = raw || null;
      }

      if (typeof body.recapEnabled === 'boolean') {
        patch.recapEnabled = body.recapEnabled;
      }
      if (typeof body.recapPublicPage === 'boolean') {
        patch.recapPublicPage = body.recapPublicPage;
      }
      if (typeof body.recapShowNames === 'boolean') {
        patch.recapShowNames = body.recapShowNames;
      }
      if (body.recapDays !== undefined && body.recapDays !== null) {
        const d = Number(body.recapDays);
        if (!Number.isInteger(d) || d < RECAP_MIN_DAYS || d > RECAP_MAX_DAYS) {
          return res.status(400).json({
            error: `La fenêtre doit être comprise entre ${RECAP_MIN_DAYS} et ${RECAP_MAX_DAYS} jours.`,
          });
        }
        patch.recapDays = d;
      }
      if (body.recapRefreshHours !== undefined && body.recapRefreshHours !== null) {
        const h = Number(body.recapRefreshHours);
        if (!Number.isFinite(h) || h < 1 || h > STEAM_SYNC_MAX_HOURS) {
          return res.status(400).json({ error: 'Fréquence de régénération invalide.' });
        }
        patch.recapRefreshHours = Math.round(h);
      }
      if (body.recapHour !== undefined && body.recapHour !== null) {
        const hour = Number(body.recapHour);
        if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
          return res.status(400).json({ error: 'Heure de régénération invalide (0 à 23).' });
        }
        patch.recapHour = hour;
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

      if (patch.recapChannelId !== undefined) {
        const before = await getSettings();
        if (before.recapChannelId !== patch.recapChannelId) {
          patch.recapMessageId = null;
        }
      }

      const settings = await updateSettings(patch);

      /**
       * Basculer « pseudos » change le CONTENU de l'image (et du message
       * Discord). On régénère tout de suite : sinon l'ancienne version, avec
       * les pseudos, resterait affichée jusqu'à la prochaine visite.
       */
      if (patch.recapShowNames !== undefined) {
        await generateRecapImage().catch((err) => {
          console.error('[admin/settings] régénération du récap’ impossible', err?.message);
        });
      }

      return res.status(200).json({ ok: true, settings });
    }

    return res.status(405).json({ error: `Méthode ${method} non supportée.` });
  } catch (err: any) {
    console.error('[admin/settings]', err);
    return res.status(500).json({ error: err.message });
  }
}
