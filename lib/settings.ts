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
}

const ROW_ID = 'app';

/** Bornes acceptées pour l'intervalle (en heures). */
export const STEAM_SYNC_MIN_HOURS = 1;
export const STEAM_SYNC_MAX_HOURS = 168;

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

  await db
    .insert(appSettings)
    .values({ id: ROW_ID, ...clamped })
    .onConflictDoUpdate({ target: appSettings.id, set: clamped });

  return getSettings();
}
