<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { apiGet, apiPost } from '../lib/api';
import { useAuth } from '../lib/auth';
import EventCreateModal from '../components/EventCreateModal.vue';

interface DiscordEvent {
  id: string;
  name: string;
  description: string | null;
  status: number;
  statusLabel: string;
  entityType: number;
  entityLabel: string;
  location: string | null;
  coverImage: string | null;
  interestedCount: number;
  startAt: string;
  endAt: string | null;
  isPast: boolean;
  isCancelled: boolean;
}

const { me } = useAuth();

const upcoming = ref<DiscordEvent[]>([]);
const past = ref<DiscordEvent[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const syncing = ref(false);
const syncMessage = ref<string | null>(null);
const configured = ref(true);
const lastSyncAt = ref<string | null>(null);
// Modal de création (admin uniquement).
const showCreate = ref(false);
const createMessage = ref<string | null>(null);

async function load() {
  loading.value = true;
  error.value = null;
  try {
    const data = await apiGet<{
      ok: boolean;
      upcoming: DiscordEvent[];
      past: DiscordEvent[];
      lastSyncAt: string | null;
      configured: boolean;
    }>('/api/events');
    upcoming.value = data.upcoming ?? [];
    past.value = data.past ?? [];
    lastSyncAt.value = data.lastSyncAt ?? null;
    configured.value = data.configured;
  } catch (e: any) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

async function sync() {
  syncing.value = true;
  syncMessage.value = null;
  error.value = null;
  try {
    const r = await apiPost<{ ok: boolean; synced: number }>('/api/events');
    syncMessage.value = `${r.synced} événement(s) synchronisé(s) depuis Discord.`;
    await load();
  } catch (e: any) {
    error.value = e.message;
  } finally {
    syncing.value = false;
  }
}

/** Retour du modal : l'événement existe sur Discord, on rafraîchit la liste. */
function onCreated(evt: { name: string }) {
  syncMessage.value = null;
  createMessage.value = `Événement « ${evt.name} » créé sur Discord.`;
  load();
}

/* ── Suppression (admin) ───────────────────────────────────── */

const pendingDelete = ref<DiscordEvent | null>(null);
const deleteBusy = ref(false);
const deleteError = ref<string | null>(null);

function askDelete(e: DiscordEvent) {
  if (!me.value.isAdmin) return;
  deleteError.value = null;
  pendingDelete.value = e;
}

function cancelDelete() {
  if (deleteBusy.value) return;
  pendingDelete.value = null;
  deleteError.value = null;
}

async function confirmDelete() {
  const target = pendingDelete.value;
  if (!target || deleteBusy.value) return;

  deleteBusy.value = true;
  deleteError.value = null;
  try {
    await apiPost('/api/events/delete', { id: target.id });

    // Retrait local immédiat : la liste doit se mettre à jour à chaud, sans
    // attendre une synchronisation Discord.
    upcoming.value = upcoming.value.filter((x) => x.id !== target.id);
    past.value = past.value.filter((x) => x.id !== target.id);

    createMessage.value = null;
    syncMessage.value = `Événement « ${target.name} » supprimé.`;
    pendingDelete.value = null;
  } catch (e: any) {
    deleteError.value = e.message;
  } finally {
    deleteBusy.value = false;
  }
}

/* ── Formatage ─────────────────────────────────────────────── */
const dateFmt = new Intl.DateTimeFormat('fr-FR', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});
const timeFmt = new Intl.DateTimeFormat('fr-FR', {
  hour: '2-digit',
  minute: '2-digit',
});

function formatDate(d: string) {
  return dateFmt.format(new Date(d));
}
function formatTime(d: string) {
  return timeFmt.format(new Date(d));
}

/** « Dans 3 jours », « demain », « aujourd'hui ». */
function relative(d: string) {
  const start = new Date(d);
  const now = new Date();
  const days = Math.round(
    (new Date(start.getFullYear(), start.getMonth(), start.getDate()).getTime() -
      new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) /
      86_400_000,
  );
  if (days === 0) return "aujourd'hui";
  if (days === 1) return 'demain';
  if (days === -1) return 'hier';
  if (days > 1) return `dans ${days} jours`;
  return `il y a ${Math.abs(days)} jours`;
}

function duration(e: DiscordEvent) {
  if (!e.endAt) return null;
  const ms = new Date(e.endAt).getTime() - new Date(e.startAt).getTime();
  const h = Math.round((ms / 3_600_000) * 10) / 10;
  return h >= 1 ? `${h} h` : `${Math.round(ms / 60_000)} min`;
}

const nextEvent = computed(() => upcoming.value[0] ?? null);

/* ── Rafraîchissement automatique ────────────────────────────────── */

/**
 * Un événement supprimé sur Discord doit disparaître sans que l'utilisateur
 * ait à recharger la page. Deux déclencheurs suffisent :
 *   - le retour sur l'onglet (le cas réel : on supprime sur Discord puis on
 *     revient sur le site) ;
 *   - un rafraîchissement discret toutes les 30 s tant que la page est visible.
 *
 * On recharge sans repasser par les squelettes : sinon la liste clignote à
 * chaque passage, ce qui est plus gênant que le problème d'origine.
 */
const REFRESH_MS = 30_000;
let refreshTimer: ReturnType<typeof setInterval> | undefined;

async function refreshQuietly() {
  // Inutile d'interroger le serveur quand l'onglet est en arrière-plan.
  if (document.visibilityState !== 'visible' || syncing.value || loading.value) return;
  try {
    const data = await apiGet<{
      ok: boolean;
      upcoming: DiscordEvent[];
      past: DiscordEvent[];
      lastSyncAt: string | null;
      configured: boolean;
    }>('/api/events');
    upcoming.value = data.upcoming ?? [];
    past.value = data.past ?? [];
    lastSyncAt.value = data.lastSyncAt ?? null;
    configured.value = data.configured;
  } catch {
    /* silencieux : la prochaine tentative réessaiera */
  }
}

function onVisibilityChange() {
  if (document.visibilityState === 'visible') refreshQuietly();
}

// Sans cet appel, `loading` restait à true et les squelettes s'affichaient
// indéfiniment (le rendu SSR ne l'exécute pas, d'où le bug passé inaperçu).
onMounted(() => {
  load();
  refreshTimer = setInterval(refreshQuietly, REFRESH_MS);
  document.addEventListener('visibilitychange', onVisibilityChange);
});

onBeforeUnmount(() => {
  if (refreshTimer) clearInterval(refreshTimer);
  document.removeEventListener('visibilitychange', onVisibilityChange);
});
</script>

<template>
  <div>
    <!-- En-tête -->
    <div class="mb-6 flex flex-wrap items-end gap-3">
      <div>
        <h1 class="font-display text-3xl font-bold text-fg-strong">Événements</h1>
        <p class="mt-1 text-sm text-fg-muted">
          Les rendez-vous du serveur Discord, directement sur le site.
        </p>
      </div>

      <div class="ml-auto flex items-center gap-2">
        <span v-if="lastSyncAt" class="hidden text-xs text-fg-faint sm:inline">
          Synchronisé {{ relative(lastSyncAt) }}
        </span>
        <button
          v-if="me.isAdmin && configured"
          class="btn-primary text-sm"
          @click="showCreate = true"
        >
          <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
          Créer un événement
        </button>
        <button
          v-if="me.isAdmin"
          class="btn-ghost text-sm"
          :disabled="syncing"
          @click="sync"
        >
          <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M21 12a9 9 0 1 1-3-6.7M21 3v6h-6" />
          </svg>
          {{ syncing ? 'Synchronisation…' : 'Synchroniser' }}
        </button>
      </div>
    </div>

    <!-- Messages -->
    <div v-if="createMessage" class="alert alert-ok mb-4">{{ createMessage }}</div>
    <div v-if="syncMessage" class="alert alert-ok mb-4">{{ syncMessage }}</div>
    <div v-if="error" class="alert alert-error mb-4">{{ error }}</div>

    <!-- Bot non configuré -->
    <div v-if="!configured && me.isAdmin" class="alert alert-warn mb-6">
      <p class="font-semibold">Le bot Discord n'est pas encore configuré.</p>
      <p class="mt-1 text-xs">
        Renseigne <code class="text-fg-strong">DISCORD_BOT_TOKEN</code> et
        <code class="text-fg-strong">DISCORD_GUILD_ID</code> dans les variables
        d'environnement, puis relance la synchronisation. Voir l'aide pour la
        procédure.
      </p>
    </div>

    <div v-if="loading" class="grid gap-4 sm:grid-cols-2">
      <div v-for="i in 4" :key="i" class="h-40 animate-pulse rounded-xl bg-app-surface2"></div>
    </div>

    <template v-else>
      <!-- Aucun événement -->
      <div v-if="upcoming.length === 0" class="card py-14 text-center">
        <p class="text-lg font-semibold text-fg-strong">Aucun événement à venir</p>
        <p class="mx-auto mt-2 max-w-md text-sm text-fg-muted">
          <template v-if="me.isAdmin">
            Crée le premier rendez-vous depuis le site, ou synchronise les
            événements déjà programmés sur le serveur Discord.
          </template>
          <template v-else>
            Les prochains rendez-vous du serveur Discord apparaîtront ici.
          </template>
        </p>
        <div v-if="me.isAdmin" class="mt-5 flex flex-wrap justify-center gap-2">
          <button v-if="configured" class="btn-primary text-sm" @click="showCreate = true">
            Créer un événement
          </button>
          <button class="btn-ghost text-sm" :disabled="syncing" @click="sync">
            {{ syncing ? 'Synchronisation…' : 'Synchroniser depuis Discord' }}
          </button>
        </div>
      </div>

      <template v-else>
        <!-- Prochain événement mis en avant -->
        <section
          v-if="nextEvent"
          class="card relative mb-6 overflow-hidden border-brand/40 p-0"
        >
          <div class="hero-glow pointer-events-none absolute inset-0"></div>
          <div class="relative flex flex-col gap-5 p-5 sm:flex-row sm:items-center">
            <div
              class="h-32 w-full shrink-0 overflow-hidden rounded-lg bg-app-surface2 sm:h-28 sm:w-52"
            >
              <img
                v-if="nextEvent.coverImage"
                :src="nextEvent.coverImage"
                :alt="nextEvent.name"
                class="h-full w-full object-cover"
              />
              <div v-else class="flex h-full items-center justify-center text-3xl">🎮</div>
            </div>

            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-2">
                <span class="badge bg-brand-soft text-brand">Prochain événement</span>
                <span class="badge bg-app-surface2 text-fg-muted">
                  {{ nextEvent.entityLabel }}
                </span>
                <span class="text-xs text-gold">{{ relative(nextEvent.startAt) }}</span>
              </div>

              <h2 class="mt-2 font-display text-xl font-bold text-fg-strong">
                {{ nextEvent.name }}
              </h2>
              <p class="mt-1 text-sm text-fg-muted">
                {{ formatDate(nextEvent.startAt) }} · {{ formatTime(nextEvent.startAt) }}
                <template v-if="duration(nextEvent)"> · {{ duration(nextEvent) }}</template>
              </p>
              <p v-if="nextEvent.description" class="mt-2 line-clamp-2 text-sm text-fg-muted">
                {{ nextEvent.description }}
              </p>

              <div class="mt-3 flex flex-wrap items-center gap-3 text-xs text-fg-faint">
                <span v-if="nextEvent.interestedCount > 0">
                  {{ nextEvent.interestedCount }} intéressé(s)
                </span>
                <span v-if="nextEvent.location" class="truncate">
                  📍 {{ nextEvent.location }}
                </span>
                <a
                  :href="`https://discord.com/events/${nextEvent.id}`"
                  target="_blank"
                  rel="noopener"
                  class="text-brand hover:underline"
                >
                  Voir sur Discord ↗
                </a>
                <button
                  v-if="me.isAdmin && configured"
                  class="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-1 text-danger transition hover:bg-danger-soft"
                  title="Supprimer cet événement sur Discord et sur le site"
                  @click="askDelete(nextEvent)"
                >
                  <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                    <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6" />
                  </svg>
                  Supprimer
                </button>
              </div>
            </div>
          </div>
        </section>

        <!-- Liste des autres événements à venir -->
        <section v-if="upcoming.length > 1">
          <h2 class="mb-3 font-display text-lg font-semibold text-fg-strong">
            À venir
          </h2>
          <div class="grid gap-4 sm:grid-cols-2">
            <article
              v-for="e in upcoming.slice(1)"
              :key="e.id"
              class="card relative flex gap-4 p-3"
            >
              <button
                v-if="me.isAdmin && configured"
                class="absolute right-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-md text-fg-faint transition hover:bg-danger-soft hover:text-danger"
                title="Supprimer cet événement"
                aria-label="Supprimer cet événement"
                @click="askDelete(e)"
              >
                <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                  <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6" />
                </svg>
              </button>
              <div class="h-20 w-28 shrink-0 overflow-hidden rounded-lg bg-app-surface2">
                <img
                  v-if="e.coverImage"
                  :src="e.coverImage"
                  :alt="e.name"
                  loading="lazy"
                  class="h-full w-full object-cover"
                />
                <div v-else class="flex h-full items-center justify-center text-xl">🎮</div>
              </div>
              <div class="min-w-0 flex-1 pr-7">
                <p class="text-xs text-gold">{{ relative(e.startAt) }}</p>
                <h3 class="truncate font-semibold text-fg-strong">{{ e.name }}</h3>
                <p class="mt-0.5 text-xs text-fg-muted">
                  {{ formatDate(e.startAt) }} · {{ formatTime(e.startAt) }}
                </p>
                <div class="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-fg-faint">
                  <span>{{ e.entityLabel }}</span>
                  <span v-if="e.interestedCount">{{ e.interestedCount }} intéressé(s)</span>
                </div>
              </div>
            </article>
          </div>
        </section>
      </template>

      <!-- Événements passés -->
      <section v-if="past.length" class="mt-10">
        <h2 class="mb-3 font-display text-lg font-semibold text-fg-strong">
          Événements passés
        </h2>
        <div class="divide-y divide-line rounded-xl border border-line">
          <div
            v-for="e in past"
            :key="e.id"
            class="flex flex-wrap items-center gap-3 px-4 py-3 text-sm"
          >
            <span class="w-24 shrink-0 text-xs text-fg-faint">
              {{ formatDate(e.startAt) }}
            </span>
            <span class="min-w-0 flex-1 truncate" :class="e.isCancelled ? 'text-fg-faint line-through' : 'text-fg'">
              {{ e.name }}
            </span>
            <span
              class="badge"
              :class="e.isCancelled ? 'bg-danger-soft text-danger' : 'bg-app-surface2 text-fg-muted'"
            >
              {{ e.statusLabel }}
            </span>
            <button
              v-if="me.isAdmin && configured"
              class="text-xs text-fg-faint transition hover:text-danger hover:underline"
              @click="askDelete(e)"
            >
              Supprimer
            </button>
          </div>
        </div>
      </section>
    </template>

    <!-- Confirmation de suppression (admin) -->
    <Teleport to="body">
      <div
        v-if="pendingDelete"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
        @click.self="cancelDelete"
      >
        <div
          class="card w-full max-w-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="evt-delete-title"
        >
          <h2 id="evt-delete-title" class="font-display text-lg font-bold text-fg-strong">
            Supprimer cet événement ?
          </h2>
          <p class="mt-2 text-sm font-medium text-fg">{{ pendingDelete.name }}</p>
          <p class="mt-1 text-xs text-fg-muted">
            {{ formatDate(pendingDelete.startAt) }} · {{ formatTime(pendingDelete.startAt) }}
          </p>
          <p class="mt-3 text-sm text-fg-muted">
            Il sera supprimé du serveur Discord <strong class="text-fg">et</strong> du
            site. Cette action est définitive.
          </p>

          <div v-if="deleteError" class="alert alert-error mt-3 text-xs">{{ deleteError }}</div>

          <div class="mt-4 flex justify-end gap-2">
            <button class="btn-ghost text-sm" :disabled="deleteBusy" @click="cancelDelete">
              Annuler
            </button>
            <button class="btn-danger text-sm" :disabled="deleteBusy" @click="confirmDelete">
              {{ deleteBusy ? 'Suppression…' : 'Supprimer' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Modal de création : monté uniquement à l'ouverture -->
    <EventCreateModal v-if="showCreate" @close="showCreate = false" @created="onCreated" />
  </div>
</template>
