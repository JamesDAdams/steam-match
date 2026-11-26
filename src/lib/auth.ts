import { ref, computed } from 'vue';
import { apiGet } from './api';

export interface SteamState {
  steamid: string;
  personaName: string;
  /** Avatar Steam, affiché à côté du compte principal dans le profil. */
  avatarUrl?: string | null;
  profileVisible: boolean;
  gamesVisible: boolean;
  lastSyncAt: string | null;
}

export interface MeState {
  authenticated: boolean;
  /** Drapeaux d'affichage pilotés depuis l'admin. */
  features?: { recommendations?: boolean; recap?: boolean };
  allowed?: boolean;
  isAdmin?: boolean;
  /** Pourquoi l'accès est accordé : admin, membre du serveur, ou exception. */
  accessSource?: 'admin' | 'member' | 'whitelist' | null;
  /** Pourquoi il est refusé, le cas échéant. */
  accessReason?: 'NOT_MEMBER' | 'MEMBERSHIP_UNVERIFIED' | null;
  /** Membre du serveur Discord (dernière vérification connue). */
  isMember?: boolean;
  membershipCheckedAt?: string | null;
  membershipCheck?: 'ok' | 'error' | 'disabled';
  membershipError?: string | null;
  botConfigured?: boolean;
  /** Lien d'invitation au serveur, si l'admin l'a renseigné. */
  guildInviteUrl?: string | null;
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
