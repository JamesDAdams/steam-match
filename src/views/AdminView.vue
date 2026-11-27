<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { apiGet, apiPost } from '../lib/api';

interface Allowed {
  discordId: string;
  note: string | null;
  addedBy: string | null;
  createdAt: string;
}

interface Known {
  discordId: string;
  username: string;
  globalName: string | null;
  avatarUrl: string | null;
  lastLoginAt: string | null;
  isAllowed: boolean;
  isAdmin: boolean;
  isMember: boolean;
  memberCheckedAt: string | null;
  hasSteam: boolean;
  steam: { steamid: string; personaName: string | null } | null;
}

const allowed = ref<Allowed[]>([]);
const known = ref<Known[]>([]);
const admins = ref<string[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const success = ref<string | null>(null);
// Vérification d'appartenance au serveur : nécessite le bot Discord.
const botConfigured = ref(true);
const guildId = ref<string | null>(null);
const inviteUrl = ref<string | null>(null);

// Formulaire d'ajout
const input = ref('');
const note = ref('');
const saving = ref(false);

// Filtre de recherche dans la liste connue
const search = ref('');

const filteredKnown = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return known.value;
  return known.value.filter(
    (k) =>
      k.username.toLowerCase().includes(q) ||
      (k.globalName ?? '').toLowerCase().includes(q) ||
      k.discordId.includes(q) ||
      (k.steam?.personaName ?? '').toLowerCase().includes(q),
  );
});

// Les comptes jamais vus mais déjà autorisés doivent rester visibles.
const knownIds = computed(() => new Set(known.value.map((k) => k.discordId)));

/* ── Synchronisation Steam ──────────────────────────────────────────── */

interface SteamSettings {
  steamSyncEnabled: boolean;
  steamSyncIntervalHours: number;
  lastSteamSyncAt: string | null;
  lastSteamSyncResult: string | null;
  recommendationsEnabled?: boolean;
  releaseNotifyEnabled: boolean;
  releaseNotifyHour: number;
  releaseChannelId: string | null;
  lastReleaseNotifyAt: string | null;
  recapEnabled: boolean;
  recapPublicPage: boolean;
  recapShowNames: boolean;
  recapDays: number;
  recapRefreshHours: number;
  recapHour: number;
  lastRecapAt: string | null;
  recapChannelId: string | null;
  recapMessageId: string | null;
}

const steamSettings = ref<SteamSettings | null>(null);
const discordChannels = ref<{ id: string; name: string }[]>([]);
const steamAccountsCount = ref<{ main: number; linked: number }>({ main: 0, linked: 0 });
const recapInfo = ref<{
  generatedAt: string;
  windowDays: number;
  mode: string;
  top: string[];
  launched: number;
} | null>(null);
/** Diagnostic du salon du récap' : le bot peut-il y écrire ? */
const recapChannel = ref<{ canPost: boolean; missing: string[]; reason?: string } | null>(null);
/** Message d'échec de publication (affiché en rouge). */
const recapError = ref<string | null>(null);
const steamSaving = ref(false);
const steamRunning = ref(false);
const steamMessage = ref<string | null>(null);

/** Intervalles proposés dans la liste déroulante (heures). */
const STEAM_INTERVALS = [1, 3, 6, 12, 24, 48, 168];

async function loadSteamSettings() {
  try {
    const r = await apiGet<{
      settings: SteamSettings;
      accounts: { main: number; linked: number };
      channels?: { id: string; name: string }[];
      recap?: {
        generatedAt: string;
        windowDays: number;
        mode: string;
        top: string[];
        launched: number;
      } | null;
      recapChannel?: { canPost: boolean; missing: string[]; reason?: string } | null;
    }>('/api/admin/settings');
    steamSettings.value = r.settings;
    steamAccountsCount.value = r.accounts ?? { main: 0, linked: 0 };
    discordChannels.value = r.channels ?? [];
    recapInfo.value = r.recap ?? null;
    recapChannel.value = r.recapChannel ?? null;
  } catch {
    /* section secondaire : on n'empêche pas l'admin de travailler */
  }
}

async function saveSteamSettings(patch: { enabled?: boolean; intervalHours?: number }) {
  steamSaving.value = true;
  steamMessage.value = null;
  error.value = null;
  try {
    const r = await apiPost<{ settings: SteamSettings }>('/api/admin/settings', patch);
    steamSettings.value = r.settings;
    steamMessage.value = 'Réglage enregistré.';
  } catch (e: any) {
    error.value = e.message;
  } finally {
    steamSaving.value = false;
  }
}

/* ── Rappels Discord des sorties ───────────────────────────────────── */

const releaseSaving = ref(false);
const releaseRunning = ref(false);
const releaseMessage = ref<string | null>(null);

const HOURS = Array.from({ length: 24 }, (_, i) => i);

async function saveRelease(patch: {
  releaseNotifyEnabled?: boolean;
  releaseNotifyHour?: number;
  releaseChannelId?: string | null;
}) {
  releaseSaving.value = true;
  releaseMessage.value = null;
  error.value = null;
  try {
    const r = await apiPost<{ settings: SteamSettings & any }>('/api/admin/settings', patch);
    steamSettings.value = r.settings as any;
    releaseMessage.value = 'Réglage enregistré.';
  } catch (e: any) {
    error.value = e.message;
  } finally {
    releaseSaving.value = false;
  }
}

async function runReleaseNow() {
  releaseRunning.value = true;
  releaseMessage.value = null;
  error.value = null;
  try {
    const r = await apiPost<{
      report: { games: number; members: number; sent: number; skipped?: string; errors: string[] };
    }>('/api/admin/settings', { action: 'run-releases' });
    const rep = r.report;
    releaseMessage.value = rep.skipped
      ? `Rien envoyé (${rep.skipped}).`
      : `${rep.games} sortie(s), ${rep.members} membre(s) concerné(s), ${rep.sent} message(s) envoyé(s)` +
        (rep.errors.length ? ` — ${rep.errors[0]}` : '.');
    await loadSteamSettings();
  } catch (e: any) {
    error.value = e.message;
  } finally {
    releaseRunning.value = false;
  }
}

/* ── Récap' du groupe (image publiée) ──────────────────────────────── */

const recapSaving = ref(false);
const recapRunning = ref(false);
const recapMessage = ref<string | null>(null);

/** Fréquences proposées (heures) : 24 = une fois par jour à l'heure choisie. */
const RECAP_FREQUENCIES = [6, 12, 24, 48, 168];
const RECAP_DAYS = [3, 7, 14, 30];

function frequencyLabel(hours: number): string {
  if (hours === 24) return 'Tous les jours';
  if (hours === 168) return 'Toutes les semaines';
  if (hours === 48) return 'Tous les 2 jours';
  return `Toutes les ${hours} h`;
}

async function saveRecap(patch: {
  recapEnabled?: boolean;
  recapPublicPage?: boolean;
  recapShowNames?: boolean;
  recapDays?: number;
  recapRefreshHours?: number;
  recapHour?: number;
  recapChannelId?: string | null;
}) {
  recapSaving.value = true;
  recapMessage.value = null;
  error.value = null;
  try {
    const r = await apiPost<{ settings: SteamSettings }>('/api/admin/settings', patch);
    steamSettings.value = r.settings;
    recapMessage.value = 'Réglage enregistré.';
    await loadSteamSettings();
  } catch (e: any) {
    error.value = e.message;
  } finally {
    recapSaving.value = false;
  }
}

async function runRecapNow() {
  recapRunning.value = true;
  recapMessage.value = null;
  recapError.value = null;
  error.value = null;
  try {
    const r = await apiPost<{
      report: {
        days: number;
        mode: string;
        top: { name: string; minutes: number }[];
        launched: number;
        players: number;
        discord?:
          | { published: boolean; reason?: string; grantedPermissions?: boolean }
          | null;
      };
    }>('/api/admin/settings', { action: 'run-recap' });
    const rep = r.report;
    const image =
      `${rep.days} jours, ${rep.launched} jeu(x) lancé(s), ${rep.players} joueur(s)` +
      (rep.mode === 'estimated' ? ' — estimation (historique en cours)' : '');

    const discord = rep.discord;
    if (!steamSettings.value?.recapChannelId) {
      recapMessage.value = `Image régénérée (${image}). Aucun salon Discord configuré.`;
    } else if (discord?.published) {
      recapMessage.value =
        `Image régénérée (${image}); message Discord mis à jour.` +
        (discord.grantedPermissions
          ? ' Le bot s’est autorisé l’écriture dans le salon.'
          : '');
    } else {
      recapMessage.value = `Image régénérée (${image}), mais Discord n’a rien reçu.`;
      recapError.value =
        discord?.reason ??
        'Publication Discord impossible : le bot n’a pas pu écrire dans le salon.';
    }
    await loadSteamSettings();
  } catch (e: any) {
    error.value = e.message;
  } finally {
    recapRunning.value = false;
  }
}

async function runSteamSyncNow() {
  steamRunning.value = true;
  steamMessage.value = null;
  error.value = null;
  try {
    const r = await apiPost<{
      report: { handled: number; failed: number; remaining: number };
    }>('/api/admin/settings', { action: 'run' });
    const rep = r.report;
    steamMessage.value =
      `${rep.handled} compte(s) synchronisé(s)` +
      (rep.failed ? `, ${rep.failed} en échec` : '') +
      (rep.remaining ? `, ${rep.remaining} en attente (passage suivant)` : '') +
      '.';
    await loadSteamSettings();
  } catch (e: any) {
    error.value = e.message;
  } finally {
    steamRunning.value = false;
  }
}

function steamIntervalLabel(hours: number) {
  if (hours === 1) return 'Toutes les heures';
  if (hours === 24) return 'Tous les jours';
  if (hours === 48) return 'Tous les 2 jours';
  if (hours === 168) return 'Toutes les semaines';
  return `Toutes les ${hours} heures`;
}

async function load() {
  loading.value = true;
  error.value = null;
  try {
    const data = await apiGet<{
      ok: boolean;
      allowed: Allowed[];
      known: Known[];
      admins: string[];
      botConfigured: boolean;
      guildId: string | null;
      inviteUrl: string | null;
    }>('/api/admin/users');
    allowed.value = data.allowed ?? [];
    known.value = data.known ?? [];
    admins.value = data.admins ?? [];
    botConfigured.value = data.botConfigured !== false;
    guildId.value = data.guildId ?? null;
    inviteUrl.value = data.inviteUrl ?? null;
  } catch (e: any) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

onMounted(loadSteamSettings);

async function addIds() {
  const raw = input.value.trim();
  if (!raw) return;

  saving.value = true;
  error.value = null;
  success.value = null;
  try {
    const ids = raw.split(/[\s,;]+/).filter(Boolean);
    const r = await apiPost<{ ok: boolean; added: string[]; count: number }>(
      '/api/admin/users',
      { discordIds: ids, note: note.value.trim() || null },
    );
    success.value = `${r.count} identifiant(s) autorisé(s).`;
    input.value = '';
    note.value = '';
    await load();
  } catch (e: any) {
    error.value = e.message;
  } finally {
    saving.value = false;
  }
}

async function removeId(id: string) {
  if (!confirm(`Retirer l'accès à ${id} ?`)) return;

  error.value = null;
  success.value = null;
  try {
    const res = await fetch(`/api/admin/users?id=${encodeURIComponent(id)}`, {
      method: 'DELETE',
      credentials: 'same-origin',
    });
    if (!res.ok) {
      const d = await res.json().catch(() => null);
      throw new Error(d?.error ?? `Erreur HTTP ${res.status}`);
    }
    success.value = `Accès retiré pour ${id}.`;
    await load();
  } catch (e: any) {
    error.value = e.message;
  }
}

function addKnown(id: string) {
  input.value = id;
  addIds();
}

function since(d: string | null) {
  if (!d) return 'jamais';
  const mins = Math.floor((Date.now() - new Date(d).getTime()) / 60000);
  if (mins < 1) return "à l'instant";
  if (mins < 60) return `il y a ${mins} min`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `il y a ${h} h`;
  return `il y a ${Math.floor(h / 24)} j`;
}

onMounted(load);
</script>

<template>
  <div class="mx-auto max-w-5xl">
    <div class="mb-6">
      <h1 class="text-2xl font-bold text-fg-strong">Administration</h1>
      <p class="mt-1 text-sm text-fg-muted">
        Les membres du serveur Discord entrent automatiquement. Cette page sert
        aux exceptions : les comptes qui ne sont pas sur le serveur.
      </p>
    </div>

    <!-- Alerte erreur / succès -->
    <div v-if="error" class="card mb-4 border-danger bg-danger-soft text-sm text-danger">
      {{ error }}
    </div>
    <div v-if="success" class="card mb-4 border-emerald-500/40 bg-emerald-500/5 text-sm text-ok">
      {{ success }}
    </div>

    <!-- État de la vérification d'appartenance -->
    <div v-if="!botConfigured" class="alert alert-warn mb-4">
      <p class="font-semibold">Vérification d'appartenance désactivée</p>
      <p class="mt-1 text-xs">
        <code class="text-warn">DISCORD_BOT_TOKEN</code> ou
        <code class="text-warn">DISCORD_GUILD_ID</code> manquant : les membres du
        serveur ne sont pas reconnus automatiquement. Seuls les comptes listés
        ci-dessous peuvent se connecter. Renseigne ces deux variables, redéploie,
        puis reconnecte-toi pour activer la vérification.
      </p>
    </div>
    <div v-else class="alert alert-info mb-4 text-xs">
      Les membres du serveur Discord
      <code v-if="guildId" class="text-brand">{{ guildId }}</code>
      sont reconnus à chaque connexion. La liste ci-dessous ajoute des personnes
      qui n'y sont pas.
      <a v-if="inviteUrl" :href="inviteUrl" target="_blank" rel="noopener" class="ml-1 underline">
        Lien d'invitation du serveur ↗
      </a>
    </div>

    <!-- Synchronisation Steam -->
    <section class="card mb-6">
      <h2 class="font-semibold text-fg-strong">Synchronisation Steam</h2>
      <p class="mt-1 max-w-2xl text-xs text-fg-faint">
        Rafraîchit les ludothèques de <strong class="text-fg-muted">tous les comptes</strong>
        (principal, secondaires et famille) pour récupérer les nouveaux jeux. La tâche
        se réveille toutes les 15 minutes et ne travaille que si l'intervalle ci-dessous
        est écoulé.
      </p>

      <div class="mt-3 flex flex-wrap items-center gap-3">
        <span class="text-sm text-fg-muted">
          {{ steamAccountsCount.main }} compte(s) principal(aux) ·
          {{ steamAccountsCount.linked }} compte(s) secondaire(s)/famille
        </span>
      </div>

      <div class="mt-4 grid gap-3 sm:grid-cols-2">
        <div>
          <label for="steam-interval" class="mb-1 block text-xs font-medium text-fg-muted">
            Fréquence
          </label>
          <select
            id="steam-interval"
            class="input"
            :disabled="steamSaving || !steamSettings"
            :value="steamSettings?.steamSyncIntervalHours ?? 1"
            @change="
              saveSteamSettings({
                intervalHours: Number(($event.target as HTMLSelectElement).value),
              })
            "
          >
            <option v-for="h in STEAM_INTERVALS" :key="h" :value="h">
              {{ steamIntervalLabel(h) }}
            </option>
          </select>
        </div>

        <div>
          <span class="mb-1 block text-xs font-medium text-fg-muted">État</span>
          <button
            type="button"
            class="flex w-full items-center justify-between rounded-lg border border-line px-3 py-2 text-left text-sm transition hover:border-line-strong"
            :disabled="steamSaving || !steamSettings"
            @click="saveSteamSettings({ enabled: !steamSettings?.steamSyncEnabled })"
          >
            <span class="text-fg">
              {{ steamSettings?.steamSyncEnabled ? 'Automatique activé' : 'Automatique désactivé' }}
            </span>
            <span
              class="badge"
              :class="
                steamSettings?.steamSyncEnabled
                  ? 'bg-ok-soft text-ok'
                  : 'bg-app-surface2 text-fg-muted'
              "
            >
              {{ steamSettings?.steamSyncEnabled ? 'ON' : 'OFF' }}
            </span>
          </button>
        </div>
      </div>

      <div class="mt-4 flex flex-wrap items-center gap-3">
        <button
          class="btn-primary text-sm"
          :disabled="steamRunning"
          @click="runSteamSyncNow"
        >
          {{ steamRunning ? 'Synchronisation…' : 'Synchroniser maintenant' }}
        </button>
        <span v-if="steamSettings?.lastSteamSyncAt" class="text-xs text-fg-faint">
          Dernier passage :
          {{ new Date(steamSettings.lastSteamSyncAt).toLocaleString('fr-FR') }}
          <template v-if="steamSettings.lastSteamSyncResult">
            · {{ steamSettings.lastSteamSyncResult }}
          </template>
        </span>
      </div>

      <p v-if="steamMessage" class="mt-2 text-xs text-ok">{{ steamMessage }}</p>
    </section>

    <!-- Rappels de sortie Discord -->
    <section class="card mb-6">
      <h2 class="font-semibold text-fg-strong">Rappels de sortie (Discord)</h2>
      <p class="mt-1 max-w-2xl text-xs text-fg-faint">
        Chaque jour à l'heure choisie, le site mentionne les membres qui l'ont
        demandé quand un jeu de leur wishlist sort. Un seul message par membre,
        même si plusieurs jeux sortent le même jour.
      </p>

      <div class="mt-4 grid gap-3 sm:grid-cols-3">
        <div>
          <span class="mb-1 block text-xs font-medium text-fg-muted">Envoi</span>
          <button
            type="button"
            class="flex w-full items-center justify-between rounded-lg border border-line px-3 py-2 text-left text-sm transition hover:border-line-strong disabled:opacity-50"
            :disabled="releaseSaving || !steamSettings"
            @click="saveRelease({ releaseNotifyEnabled: !steamSettings?.releaseNotifyEnabled })"
          >
            <span class="text-fg">
              {{ steamSettings?.releaseNotifyEnabled ? 'Activé' : 'Désactivé' }}
            </span>
            <span
              class="badge"
              :class="
                steamSettings?.releaseNotifyEnabled
                  ? 'bg-ok-soft text-ok'
                  : 'bg-app-surface2 text-fg-muted'
              "
            >
              {{ steamSettings?.releaseNotifyEnabled ? 'ON' : 'OFF' }}
            </span>
          </button>
        </div>

        <div>
          <label for="release-hour" class="mb-1 block text-xs font-medium text-fg-muted">
            Heure (Paris)
          </label>
          <select
            id="release-hour"
            class="input"
            :disabled="releaseSaving || !steamSettings"
            :value="steamSettings?.releaseNotifyHour ?? 6"
            @change="
              saveRelease({
                releaseNotifyHour: Number(($event.target as HTMLSelectElement).value),
              })
            "
          >
            <option v-for="h in HOURS" :key="h" :value="h">
              {{ String(h).padStart(2, '0') }}:00
            </option>
          </select>
        </div>

        <div>
          <label for="release-channel" class="mb-1 block text-xs font-medium text-fg-muted">
            Salon Discord
          </label>
          <select
            id="release-channel"
            class="input"
            :disabled="releaseSaving"
            :value="steamSettings?.releaseChannelId ?? ''"
            @change="
              saveRelease({
                releaseChannelId: ($event.target as HTMLSelectElement).value || null,
              })
            "
          >
            <option value="">Automatique (salon « games »)</option>
            <option v-for="c in discordChannels" :key="c.id" :value="c.id">
              {{ c.name }}
            </option>
          </select>
        </div>
      </div>

      <div class="mt-4 flex flex-wrap items-center gap-3">
        <button class="btn-ghost text-sm" :disabled="releaseRunning" @click="runReleaseNow">
          {{ releaseRunning ? 'Envoi…' : 'Envoyer maintenant' }}
        </button>
        <span v-if="steamSettings?.lastReleaseNotifyAt" class="text-xs text-fg-faint">
          Dernier envoi :
          {{ new Date(steamSettings.lastReleaseNotifyAt).toLocaleString('fr-FR') }}
        </span>
      </div>

      <p v-if="releaseMessage" class="mt-2 text-xs text-ok">{{ releaseMessage }}</p>
    </section>

    <!-- Récap' du groupe -->
    <section class="card mb-6">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 class="font-semibold text-fg-strong">Récap’ du groupe (image)</h2>
        <router-link to="/recap" class="text-xs text-gold hover:underline">
          Voir la page →
        </router-link>
      </div>
      <p class="mt-1 max-w-2xl text-xs text-fg-faint">
        Publie une image récapitulative : les jeux les plus joués sur la période, puis tous les jeux
        lancés par les membres. Régénérée automatiquement à l'heure choisie — l'image est aussi
        téléchargeable en PNG pour la poster sur Discord.
      </p>

      <div class="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <span class="mb-1 block text-xs font-medium text-fg-muted">Publication</span>
          <button
            type="button"
            class="flex w-full items-center justify-between rounded-lg border border-line px-3 py-2 text-left text-sm transition hover:border-line-strong disabled:opacity-50"
            :disabled="recapSaving || !steamSettings"
            @click="saveRecap({ recapEnabled: !steamSettings?.recapEnabled })"
          >
            <span class="text-fg">{{ steamSettings?.recapEnabled ? 'Activé' : 'Désactivé' }}</span>
            <span
              class="badge"
              :class="
                steamSettings?.recapEnabled ? 'bg-ok-soft text-ok' : 'bg-app-surface2 text-fg-muted'
              "
            >
              {{ steamSettings?.recapEnabled ? 'ON' : 'OFF' }}
            </span>
          </button>
        </div>

        <div>
          <span class="mb-1 block text-xs font-medium text-fg-muted">Page publique</span>
          <button
            type="button"
            class="flex w-full items-center justify-between rounded-lg border border-line px-3 py-2 text-left text-sm transition hover:border-line-strong disabled:opacity-50"
            :disabled="recapSaving || !steamSettings"
            title="Visible sans compte Discord, avec « x joueurs » à la place des pseudos."
            @click="saveRecap({ recapPublicPage: !steamSettings?.recapPublicPage })"
          >
            <span class="text-fg">{{ steamSettings?.recapPublicPage ? 'Visible' : 'Membres' }}</span>
            <span
              class="badge"
              :class="
                steamSettings?.recapPublicPage ? 'bg-ok-soft text-ok' : 'bg-app-surface2 text-fg-muted'
              "
            >
              {{ steamSettings?.recapPublicPage ? 'PUBLIC' : 'PRIVÉ' }}
            </span>
          </button>
        </div>

        <div>
          <span class="mb-1 block text-xs font-medium text-fg-muted">Pseudos</span>
          <button
            type="button"
            class="flex w-full items-center justify-between rounded-lg border border-line px-3 py-2 text-left text-sm transition hover:border-line-strong disabled:opacity-50"
            :disabled="recapSaving || !steamSettings"
            title="Désactivé : l'image et la page affichent « 3 joueurs » au lieu des noms."
            @click="saveRecap({ recapShowNames: !steamSettings?.recapShowNames })"
          >
            <span class="text-fg">{{ steamSettings?.recapShowNames ? 'Affichés' : 'Masqués' }}</span>
            <span
              class="badge"
              :class="
                steamSettings?.recapShowNames ? 'bg-ok-soft text-ok' : 'bg-app-surface2 text-fg-muted'
              "
            >
              {{ steamSettings?.recapShowNames ? 'ON' : 'OFF' }}
            </span>
          </button>
        </div>

        <div>
          <label for="recap-days" class="mb-1 block text-xs font-medium text-fg-muted">
            Fenêtre
          </label>
          <select
            id="recap-days"
            class="input"
            :disabled="recapSaving || !steamSettings"
            :value="steamSettings?.recapDays ?? 7"
            @change="
              saveRecap({ recapDays: Number(($event.target as HTMLSelectElement).value) })
            "
          >
            <option v-for="d in RECAP_DAYS" :key="d" :value="d">
              {{ d }} jours
            </option>
          </select>
        </div>

        <div>
          <label for="recap-frequency" class="mb-1 block text-xs font-medium text-fg-muted">
            Régénération
          </label>
          <select
            id="recap-frequency"
            class="input"
            :disabled="recapSaving || !steamSettings"
            :value="steamSettings?.recapRefreshHours ?? 24"
            @change="
              saveRecap({
                recapRefreshHours: Number(($event.target as HTMLSelectElement).value),
              })
            "
          >
            <option v-for="h in RECAP_FREQUENCIES" :key="h" :value="h">
              {{ frequencyLabel(h) }}
            </option>
          </select>
        </div>

        <div>
          <label for="recap-hour" class="mb-1 block text-xs font-medium text-fg-muted">
            Heure (Paris)
          </label>
          <select
            id="recap-hour"
            class="input"
            :disabled="recapSaving || !steamSettings"
            :value="steamSettings?.recapHour ?? 6"
            @change="
              saveRecap({ recapHour: Number(($event.target as HTMLSelectElement).value) })
            "
          >
            <option v-for="h in HOURS" :key="h" :value="h">
              {{ String(h).padStart(2, '0') }}:00
            </option>
          </select>
        </div>

        <div>
          <label for="recap-channel" class="mb-1 block text-xs font-medium text-fg-muted">
            Salon Discord
          </label>
          <select
            id="recap-channel"
            class="input"
            :disabled="recapSaving"
            :value="steamSettings?.recapChannelId ?? ''"
            @change="
              saveRecap({ recapChannelId: ($event.target as HTMLSelectElement).value || null })
            "
          >
            <option value="">Aucun (site seulement)</option>
            <option v-for="c in discordChannels" :key="c.id" :value="c.id">
              {{ c.name }}
            </option>
          </select>
        </div>
      </div>

      <!-- Le salon choisi est en lecture seule pour @everyone : sans ce
           contrôle, l'envoi échouait en 403 sans que rien ne s'affiche. -->
      <p
        v-if="recapChannel && !recapChannel.canPost && steamSettings?.recapChannelId"
        class="mt-3 rounded-lg border border-warn/40 bg-warn-soft px-3 py-2 text-xs text-warn"
      >
        Le bot n'a pas encore le droit d'écrire dans ce salon
        <template v-if="recapChannel.missing.length">
          ({{ recapChannel.missing.join(', ') }})
        </template>
        . « Régénérer maintenant » lui ajoute l'autorisation automatiquement, puis publie le
        message.
      </p>

      <div class="mt-4 flex flex-wrap items-center gap-3">
        <button class="btn-ghost text-sm" :disabled="recapRunning" @click="runRecapNow">
          {{ recapRunning ? 'Génération…' : 'Régénérer maintenant' }}
        </button>
        <span v-if="recapInfo" class="text-xs text-fg-faint">
          Dernière image : {{ new Date(recapInfo.generatedAt).toLocaleString('fr-FR') }} —
          {{ recapInfo.windowDays }} j, {{ recapInfo.launched }} jeu(x)
          <template v-if="recapInfo.mode === 'estimated'"> (estimation)</template>
        </span>
      </div>

      <p
        v-if="recapMessage"
        class="mt-2 text-xs"
        :class="recapError ? 'text-fg-muted' : 'text-ok'"
      >
        {{ recapMessage }}
      </p>
      <p v-if="recapError" class="mt-1 text-xs text-danger">{{ recapError }}</p>

      <p class="mt-3 text-[11px] leading-relaxed text-fg-faint">
        <strong>Page publique</strong> : la page <code>/recap</code> s'ouvre alors sans compte
        Discord — les pseudos y sont remplacés par « x joueurs », y compris dans l'image (une
        variante dédiée est générée). Les membres connectés voient les pseudos quand
        <strong>Pseudos</strong> est activé.
      </p>
      <p class="mt-1 text-[11px] leading-relaxed text-fg-faint">
        Steam ne publie que le temps de jeu cumulé et les 14 derniers jours : la « fenêtre » est
        mesurée par des relevés quotidiens, qui se constituent au fil des synchronisations. Tant que
        l'historique est trop court, l'image l'indique (« estimation »).
      </p>
      <p class="mt-1 text-[11px] leading-relaxed text-fg-faint">
        <template v-if="steamSettings?.recapChannelId">
          Le bot poste <strong>un seul message</strong> dans le salon choisi, avec l'aperçu de
          l'image, et l'édite à chaque régénération — le salon ne se remplit pas.
        </template>
        <template v-else>
          Choisis un salon Discord pour que le bot y publie l'image ; sinon elle reste sur le site
          uniquement.
        </template>
      </p>
    </section>

    <!-- Pages du site -->
    <section class="card mb-6">
      <h2 class="font-semibold text-fg-strong">Pages visibles</h2>
      <p class="mt-1 max-w-2xl text-xs text-fg-faint">
        Certaines pages sont en chantier. Désactivées, elles disparaissent du menu
        (toi seul peux encore y accéder par l'adresse).
      </p>

      <button
        type="button"
        class="mt-3 flex w-full max-w-md items-center justify-between rounded-lg border border-line px-3 py-2 text-left text-sm transition hover:border-line-strong disabled:opacity-50"
        :disabled="steamSaving || !steamSettings"
        @click="saveRelease({ recommendationsEnabled: !steamSettings?.recommendationsEnabled } as any)"
      >
        <span>
          <span class="block text-fg">Recommandations</span>
          <span class="text-[11px] text-fg-faint">Le jeu qui plaira à tout le monde</span>
        </span>
        <span
          class="badge"
          :class="
            steamSettings?.recommendationsEnabled
              ? 'bg-ok-soft text-ok'
              : 'bg-app-surface2 text-fg-muted'
          "
        >
          {{ steamSettings?.recommendationsEnabled ? 'ON' : 'OFF' }}
        </span>
      </button>
    </section>

    <!-- Ajout -->
    <section class="card mb-6">
      <h2 class="font-semibold text-fg-strong">Autoriser un compte hors serveur</h2>
      <p class="mt-1 text-xs text-fg-faint">
        Ces comptes peuvent se connecter même s'ils ne sont pas membres du
        serveur Discord. Un ID Discord = 17 à 20 chiffres. Sur Discord : clic
        droit sur le pseudo → <em>Copier l'identifiant</em>. Tu peux coller
        plusieurs IDs séparés par des espaces ou des virgules.
      </p>

      <div class="mt-3 grid gap-3 sm:grid-cols-[1fr_auto]">
        <div class="space-y-2">
          <textarea
            v-model="input"
            rows="2"
            placeholder="123456789012345678"
            class="w-full rounded border border-line bg-app-bg px-3 py-2 font-mono text-sm text-fg placeholder:text-fg-faint focus:border-brand focus:outline-none"
          ></textarea>
          <input
            v-model="note"
            placeholder="Note (optionnel) — ex. pseudo Discord"
            class="w-full rounded border border-line bg-app-bg px-3 py-2 text-sm text-fg placeholder:text-fg-faint focus:border-brand focus:outline-none"
          />
        </div>
        <button class="btn-primary h-fit text-sm" :disabled="saving || !input.trim()" @click="addIds">
          {{ saving ? 'Ajout…' : 'Autoriser' }}
        </button>
      </div>
    </section>

    <!-- Admins définis dans l'env -->
    <section class="card mb-6 border-warn bg-warn-soft">
      <h2 class="font-semibold text-warn">Administrateur(s)</h2>
      <p class="mt-1 text-xs text-fg-muted">
        Défini(s) par la variable <code class="text-warn">DISCORD_ADMIN_ID</code>.
        Toujours autorisé(s), non modifiable(s) depuis cette page.
      </p>
      <div class="mt-2 flex flex-wrap gap-2">
        <code
          v-for="a in admins"
          :key="a"
          class="rounded border border-warn bg-app-bg/40 px-2 py-1 font-mono text-xs text-warn"
        >
          {{ a }}
        </code>
        <span v-if="admins.length === 0" class="text-xs text-danger">
          Aucun admin configuré — renseigne DISCORD_ADMIN_ID.
        </span>
      </div>
    </section>

    <!-- Liste des autorisés -->
    <section class="card mb-6">
      <h2 class="font-semibold text-fg-strong">
        Exceptions autorisées
        <span class="ml-1 text-sm font-normal text-fg-faint">({{ allowed.length }})</span>
      </h2>

      <div v-if="loading" class="mt-3 h-12 animate-pulse rounded bg-app-surface2"></div>
      <p v-else-if="allowed.length === 0" class="mt-3 text-sm text-fg-faint">
        Aucun identifiant autorisé pour le moment. Les personnes qui tentent de se
        connecter apparaîtront ci-dessous avec leur ID.
      </p>
      <ul v-else class="mt-3 divide-y divide-line">
        <li
          v-for="a in allowed"
          :key="a.discordId"
          class="flex flex-wrap items-center gap-3 py-2"
        >
          <code class="font-mono text-sm text-fg">{{ a.discordId }}</code>
          <span v-if="a.note" class="text-xs text-fg-faint">{{ a.note }}</span>
          <span v-if="knownIds.has(a.discordId) === false" class="badge bg-app-surface2 text-fg-muted">
            jamais connecté
          </span>
          <button
            class="ml-auto text-xs text-danger hover:text-danger hover:underline"
            @click="removeId(a.discordId)"
          >
            Retirer
          </button>
        </li>
      </ul>
    </section>

    <!-- Comptes déjà vus -->
    <section class="card">
      <div class="flex flex-wrap items-center gap-3">
        <h2 class="font-semibold text-fg-strong">Comptes déjà connectés</h2>
        <input
          v-model="search"
          placeholder="Rechercher…"
          class="ml-auto rounded border border-line bg-app-bg px-3 py-1.5 text-sm text-fg placeholder:text-fg-faint focus:border-brand focus:outline-none"
        />
      </div>

      <div v-if="loading" class="mt-3 h-20 animate-pulse rounded bg-app-surface2"></div>
      <p v-else-if="known.length === 0" class="mt-3 text-sm text-fg-faint">
        Personne ne s'est encore connecté.
      </p>
      <ul v-else class="mt-3 divide-y divide-line">
        <li
          v-for="k in filteredKnown"
          :key="k.discordId"
          class="flex flex-wrap items-center gap-3 py-2"
        >
          <img
            v-if="k.avatarUrl"
            :src="k.avatarUrl"
            :alt="k.username"
            class="h-8 w-8 rounded-full border border-line"
          />
          <div v-else class="h-8 w-8 rounded-full border border-line bg-app-surface2"></div>

          <div class="min-w-0">
            <p class="truncate text-sm text-fg">
              {{ k.globalName || k.username }}
              <span class="text-xs text-fg-faint">@{{ k.username }}</span>
            </p>
            <p class="font-mono text-xs text-fg-faint">{{ k.discordId }}</p>
          </div>

          <div class="ml-auto flex flex-wrap items-center gap-1">
            <span v-if="k.isAdmin" class="badge bg-warn-soft text-warn">admin</span>
            <span
              v-else-if="k.isAllowed"
              class="badge bg-ok-soft text-ok"
            >autorisé</span>
            <span v-else-if="k.isMember" class="badge bg-ok-soft text-ok">membre</span>
            <span v-else class="badge bg-danger-soft text-danger">refusé</span>

            <!-- Statut d'appartenance au serveur (vérifié via le bot) -->
            <span v-if="k.isMember" class="badge bg-app-surface2 text-ok">sur le serveur</span>
            <span v-else-if="k.memberCheckedAt" class="badge bg-app-surface2 text-fg-muted">
              hors serveur
            </span>
            <span v-else class="badge bg-app-surface2 text-fg-faint">non vérifié</span>

            <span
              v-if="k.hasSteam"
              class="badge bg-app-surface2 text-brand"
            >{{ k.steam?.personaName || 'steam lié' }}</span>
            <span v-else class="badge bg-app-surface2 text-fg-muted">sans steam</span>

            <span class="text-[10px] text-fg-faint">{{ since(k.lastLoginAt) }}</span>

            <button
              v-if="!k.isAllowed && !k.isAdmin && !k.isMember"
              class="ml-2 text-xs text-brand hover:underline"
              @click="addKnown(k.discordId)"
            >
              Autoriser
            </button>
          </div>
        </li>
      </ul>
    </section>
  </div>
</template>
