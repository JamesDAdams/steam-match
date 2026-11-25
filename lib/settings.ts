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
  };
}

export async function updateSettings(
  patch: Partial<Pick<AppSettings, 'steamSyncEnabled' | 'steamSyncIntervalHours' | 'lastSteamSyncAt' | 'lastSteamSyncResult'>>,
): Promise<AppSettings> {
  const db = getDb();

  const clamped: typeof patch = { ...patch };
  if (typeof clamped.steamSyncIntervalHours === 'number') {
    clamped.steamSyncIntervalHours = Math.min(
      STEAM_SYNC_MAX_HOURS,
      Math.max(STEAM_SYNC_MIN_HOURS, Math.round(clamped.steamSyncIntervalHours)),
    );
  }

  await db
    .insert(appSettings)
    .values({ id: ROW_ID, ...clamped })
    .onConflictDoUpdate({ target: appSettings.id, set: clamped });

  return getSettings();
}
