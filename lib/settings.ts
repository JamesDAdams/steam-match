import { getDb } from '../db/index.ts';
import { appSettings } from '../db/schema.ts';
import { eq } from 'drizzle-orm';

/**
 * Réglages persistés de l'application.
 *
 * Une seule ligne (`id = 'app'`) : pas besoin d'un modèle de configuration
 * générique pour deux champs, et la lecture est triviale à mettre en cache.
 */
export interface AppSettings {
  steamSyncEnabled: boolean;
  steamSyncIntervalHours: number;
  lastSteamSyncAt: Date | null;
  lastSteamSyncResult: string | null;
  /** Page « Recommandations » affichée dans le menu. */
  recommendationsEnabled: boolean;
  /** Rappels Discord des sorties. */
  releaseNotifyEnabled: boolean;
  /** Heure d'envoi, 0-23 (heure de Paris). */
  releaseNotifyHour: number;
  /** Salon cible ; null = chercher le salon nommé « games ». */
  releaseChannelId: string | null;
  lastReleaseNotifyAt: Date | null;
  /** Récap' du groupe : image publiée sur le site. */
  recapEnabled: boolean;
  /** Fenêtre d'analyse, en jours. */
  recapDays: number;
  /** Fréquence de régénération, en heures. */
  recapRefreshHours: number;
  /** Heure de régénération quand la fréquence est quotidienne (Paris). */
  recapHour: number;
  lastRecapAt: Date | null;
}

const ROW_ID = 'app';

/** Bornes acceptées pour l'intervalle (en heures). */
export const STEAM_SYNC_MIN_HOURS = 1;
export const STEAM_SYNC_MAX_HOURS = 168;

/** Bornes du récap' : une semaine par défaut, jamais plus d'un mois. */
export const RECAP_MIN_DAYS = 1;
export const RECAP_MAX_DAYS = 30;

const DEFAULTS: AppSettings = {
  steamSyncEnabled: true,
  steamSyncIntervalHours: 1,
  lastSteamSyncAt: null,
  lastSteamSyncResult: null,
  recommendationsEnabled: false,
  releaseNotifyEnabled: false,
  releaseNotifyHour: 6,
  releaseChannelId: null,
  lastReleaseNotifyAt: null,
  recapEnabled: true,
  recapDays: 7,
  recapRefreshHours: 24,
  recapHour: 6,
  lastRecapAt: null,
};

export async function getSettings(): Promise<AppSettings> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(appSettings)
    .where(eq(appSettings.id, ROW_ID))
    .limit(1);

  if (!row) {
    // Première lecture : on matérialise les valeurs par défaut.
    await db.insert(appSettings).values({ id: ROW_ID }).onConflictDoNothing();
    return DEFAULTS;
  }

  return {
    steamSyncEnabled: row.steamSyncEnabled,
    steamSyncIntervalHours: row.steamSyncIntervalHours,
    lastSteamSyncAt: row.lastSteamSyncAt ?? null,
    lastSteamSyncResult: row.lastSteamSyncResult ?? null,
    recommendationsEnabled: row.recommendationsEnabled,
    releaseNotifyEnabled: row.releaseNotifyEnabled,
    releaseNotifyHour: row.releaseNotifyHour,
    releaseChannelId: row.releaseChannelId ?? null,
    lastReleaseNotifyAt: row.lastReleaseNotifyAt ?? null,
    recapEnabled: row.recapEnabled,
    recapDays: row.recapDays,
    recapRefreshHours: row.recapRefreshHours,
    recapHour: row.recapHour,
    lastRecapAt: row.lastRecapAt ?? null,
  };
}

export async function updateSettings(
  patch: Partial<
    Pick<
      AppSettings,
      | 'steamSyncEnabled'
      | 'steamSyncIntervalHours'
      | 'lastSteamSyncAt'
      | 'lastSteamSyncResult'
      | 'recommendationsEnabled'
      | 'releaseNotifyEnabled'
      | 'releaseNotifyHour'
      | 'releaseChannelId'
      | 'lastReleaseNotifyAt'
      | 'recapEnabled'
      | 'recapDays'
      | 'recapRefreshHours'
      | 'recapHour'
      | 'lastRecapAt'
    >
  >,
): Promise<AppSettings> {
  const db = getDb();

  const clamped: typeof patch = { ...patch };
  if (typeof clamped.steamSyncIntervalHours === 'number') {
    clamped.steamSyncIntervalHours = Math.min(
      STEAM_SYNC_MAX_HOURS,
      Math.max(STEAM_SYNC_MIN_HOURS, Math.round(clamped.steamSyncIntervalHours)),
    );
  }

  if (typeof clamped.releaseNotifyHour === 'number') {
    clamped.releaseNotifyHour = Math.min(23, Math.max(0, Math.round(clamped.releaseNotifyHour)));
  }

  if (typeof clamped.recapDays === 'number') {
    clamped.recapDays = Math.min(
      RECAP_MAX_DAYS,
      Math.max(RECAP_MIN_DAYS, Math.round(clamped.recapDays)),
    );
  }
  if (typeof clamped.recapRefreshHours === 'number') {
    clamped.recapRefreshHours = Math.min(
      STEAM_SYNC_MAX_HOURS,
      Math.max(1, Math.round(clamped.recapRefreshHours)),
    );
  }
  if (typeof clamped.recapHour === 'number') {
    clamped.recapHour = Math.min(23, Math.max(0, Math.round(clamped.recapHour)));
  }

  await db
    .insert(appSettings)
    .values({ id: ROW_ID, ...clamped })
    .onConflictDoUpdate({ target: appSettings.id, set: clamped });

  return getSettings();
}
