import { ref, computed } from 'vue';
import { apiGet } from './api';

export interface SteamState {
  steamid: string;
  personaName: string;
  profileVisible: boolean;
  gamesVisible: boolean;
  lastSyncAt: string | null;
}

export interface MeState {
  authenticated: boolean;
  allowed?: boolean;
  isAdmin?: boolean;
  discord?: {
    id: string;
    username: string;
    globalName: string | null;
    avatarUrl: string | null;
  } | null;
  steam?: SteamState | null;
}

/**
 * État d'authentification partagé entre toutes les vues.
 * Un seul chargement réseau au démarrage, puis on propage.
 */
const me = ref<MeState>({ authenticated: false });
const loading = ref(true);

export function useAuth() {
  /** Recharge l'état depuis /api/me. */
  async function refresh() {
    loading.value = true;
    try {
      const data = await apiGet<MeState & { ok: boolean }>('/api/me');
      me.value = data;
    } catch {
      me.value = { authenticated: false };
    } finally {
      loading.value = false;
    }
    return me.value;
  }

  /** Vrai si l'utilisateur peut utiliser le site. */
  const canUseSite = computed(
    () => me.value.authenticated && me.value.allowed === true,
  );

  /** Vrai si un compte Steam est relié. */
  const hasSteam = computed(() => Boolean(me.value.steam?.steamid));

  const displayName = computed(
    () =>
      me.value.discord?.globalName ||
      me.value.discord?.username ||
      'Invité',
  );

  return { me, loading, refresh, canUseSite, hasSteam, displayName };
}

/** Pour les appels hors composant (guard du routeur). */
export async function ensureAuthLoaded() {
  if (loading.value) {
    // Évite les appels concurrents au premier chargement.
    await useAuth().refresh();
  }
  return me.value;
}

export function authState() {
  return me.value;
}
