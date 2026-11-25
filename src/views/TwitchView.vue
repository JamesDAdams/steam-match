<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { apiGet } from '../lib/api';
import { useAuth } from '../lib/auth';

/**
 * Espace Twitch du serveur : les chaînes déclarées par les membres, et qui est
 * en direct maintenant.
 *
 * Le statut vient du serveur (cache 60 s). La page se rafraîchit seule pour
 * qu'un live démarré pendant la visite apparaisse sans rechargement.
 */
interface Streamer {
  memberName: string;
  login: string;
  displayName: string;
  avatarUrl: string | null;
  channelUrl: string;
  isLive: boolean;
  title: string | null;
  game: string | null;
  viewers: number | null;
  startedAt: string | null;
  thumbnailUrl: string | null;
}

const { me } = useAuth();

const loading = ref(true);
const error = ref<string | null>(null);
const streamers = ref<Streamer[]>([]);
const richStatus = ref(false);
const mine = ref<{ login: string; channelUrl: string } | null>(null);

const live = computed(() => streamers.value.filter((s) => s.isLive));
const offline = computed(() => streamers.value.filter((s) => !s.isLive));

async function load(silent = false) {
  if (!silent) loading.value = true;
  try {
    const r = await apiGet<{
      streamers: Streamer[];
      richStatus: boolean;
      mine: { login: string; channelUrl: string } | null;
    }>('/api/twitch');
    streamers.value = r.streamers ?? [];
    richStatus.value = r.richStatus;
    mine.value = r.mine ?? null;
    error.value = null;
  } catch (e: any) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

function since(iso: string | null): string | null {
  if (!iso) return null;
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'à l’instant';
  if (minutes < 60) return `depuis ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `depuis ${hours} h`;
}

/* ── Rafraîchissement automatique ─────────────────────────────────── */

const REFRESH_MS = 60_000;
let timer: ReturnType<typeof setInterval> | null = null;

function stopRefresh() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

onMounted(async () => {
  await load();
  timer = setInterval(() => {
    if (!document.hidden) void load(true);
  }, REFRESH_MS);
});

onBeforeUnmount(stopRefresh);
</script>

<template>
  <div>
    <!-- En-tête -->
    <div class="mb-6 flex flex-wrap items-end gap-3">
      <div>
        <h1 class="font-display text-3xl font-bold text-fg-strong">Espace Twitch</h1>
        <p class="mt-1 text-sm text-fg-muted">
          Les créateurs du serveur et leurs lives en cours.
        </p>
      </div>
      <div class="ml-auto flex items-center gap-2">
        <router-link v-if="me.authenticated" to="/profil" class="btn-primary text-sm">
          {{ mine ? 'Gérer ma chaîne' : 'Lier ma chaîne' }}
        </router-link>
        <a v-else href="/api/auth/discord" class="btn-primary text-sm">
          Rejoindre le serveur
        </a>
      </div>
    </div>

    <div v-if="error" class="card mb-4 border-danger bg-danger-soft text-sm text-danger">
      {{ error }}
    </div>

    <!-- Compteurs -->
    <section class="mb-6 grid gap-4 sm:grid-cols-3">
      <div class="card">
        <p class="text-xs uppercase tracking-wide text-fg-faint">Créateurs</p>
        <p class="mt-1 font-display text-2xl font-bold text-fg-strong">
          {{ streamers.length }}
        </p>
        <p class="text-xs text-fg-faint">chaînes déclarées</p>
      </div>
      <div class="card">
        <p class="text-xs uppercase tracking-wide text-fg-faint">En live</p>
        <p class="mt-1 font-display text-2xl font-bold" :class="live.length ? 'text-ok' : 'text-fg-strong'">
          {{ live.length }}
        </p>
        <p class="text-xs text-fg-faint">maintenant</p>
      </div>
      <div class="card">
        <p class="text-xs uppercase tracking-wide text-fg-faint">Ma chaîne</p>
        <p class="mt-1 truncate font-display text-2xl font-bold text-fg-strong">
          {{ mine?.login ?? '—' }}
        </p>
        <p class="text-xs text-fg-faint">
          <template v-if="mine">reliée à ton profil</template>
          <template v-else>pas encore liée</template>
        </p>
      </div>
    </section>

    <!-- En direct -->
    <section class="mb-8">
      <div class="mb-3 flex items-center gap-2">
        <h2 class="font-display text-lg font-semibold text-fg-strong">En direct maintenant</h2>
        <span v-if="live.length" class="badge bg-ok-soft text-ok">
          {{ live.length }} live{{ live.length > 1 ? 's' : '' }}
        </span>
      </div>

      <div v-if="loading" class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <div v-for="i in 3" :key="i" class="h-56 animate-pulse rounded-lg bg-app-surface2"></div>
      </div>

      <div v-else-if="live.length" class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <a
          v-for="s in live"
          :key="s.login"
          :href="s.channelUrl"
          target="_blank"
          rel="noopener"
          class="card group overflow-hidden p-0 transition hover:border-brand/50"
        >
          <div class="relative aspect-video w-full overflow-hidden bg-app-surface2">
            <img
              v-if="s.thumbnailUrl"
              :src="s.thumbnailUrl"
              :alt="s.displayName"
              class="h-full w-full object-cover transition group-hover:scale-[1.02]"
              loading="lazy"
            />
            <img
              v-else-if="s.avatarUrl"
              :src="s.avatarUrl"
              :alt="s.displayName"
              class="h-full w-full object-cover opacity-60"
              loading="lazy"
            />
            <div
              v-else
              class="flex h-full items-center justify-center text-3xl"
            >
              🎥
            </div>

            <span class="absolute left-2 top-2 flex items-center gap-1 rounded bg-danger px-2 py-0.5 text-[11px] font-semibold text-white">
              <span class="h-1.5 w-1.5 rounded-full bg-white"></span> LIVE
            </span>
            <span
              v-if="s.viewers !== null"
              class="absolute right-2 top-2 rounded bg-black/60 px-2 py-0.5 text-[11px] text-white"
            >
              {{ s.viewers }} spect.
            </span>
          </div>

          <div class="p-3">
            <p class="truncate text-sm font-semibold text-fg-strong">
              {{ s.displayName }}
            </p>
            <p class="mt-0.5 line-clamp-2 text-xs text-fg-muted">
              {{ s.title || 'Sans titre' }}
            </p>
            <div class="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-fg-faint">
              <span v-if="s.game" class="badge bg-brand-soft text-brand">{{ s.game }}</span>
              <span v-if="since(s.startedAt)">{{ since(s.startedAt) }}</span>
              <span class="truncate">par {{ s.memberName }}</span>
            </div>
          </div>
        </a>
      </div>

      <div v-else class="card py-10 text-center">
        <p class="text-lg font-semibold text-fg-strong">Aucun live en ce moment</p>
        <p class="mx-auto mt-2 max-w-md text-sm text-fg-muted">
          Personne du serveur ne streame actuellement. La page se met à jour
          toute seule dès qu’un live démarre.
        </p>
      </div>
    </section>

    <!-- Les chaînes -->
    <section>
      <h2 class="mb-3 font-display text-lg font-semibold text-fg-strong">
        Les chaînes de la communauté
      </h2>

      <div v-if="loading" class="space-y-2">
        <div v-for="i in 3" :key="i" class="h-16 animate-pulse rounded-lg bg-app-surface2"></div>
      </div>

      <ul v-else-if="streamers.length" class="space-y-2">
        <li
          v-for="s in [...live, ...offline]"
          :key="s.login"
          class="card flex flex-wrap items-center gap-3 p-3"
        >
          <img
            v-if="s.avatarUrl"
            :src="s.avatarUrl"
            :alt="s.displayName"
            class="h-10 w-10 shrink-0 rounded-full object-cover"
            loading="lazy"
          />
          <div
            v-else
            class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-app-surface2 text-sm"
          >
            🎮
          </div>

          <div class="min-w-0 flex-1">
            <p class="flex flex-wrap items-center gap-2 text-sm font-medium text-fg-strong">
              <span class="truncate">{{ s.displayName }}</span>
              <span
                class="badge"
                :class="s.isLive ? 'bg-ok-soft text-ok' : 'bg-app-surface2 text-fg-muted'"
              >
                {{ s.isLive ? 'En live' : 'Hors ligne' }}
              </span>
            </p>
            <p class="truncate text-[11px] text-fg-faint">
              twitch.tv/{{ s.login }} · membre : {{ s.memberName }}
              <template v-if="s.isLive && s.game"> · {{ s.game }}</template>
            </p>
          </div>

          <a
            :href="s.channelUrl"
            target="_blank"
            rel="noopener"
            class="rounded px-2 py-1 text-xs text-brand transition hover:bg-brand-soft"
          >
            Voir la chaîne ↗
          </a>
        </li>
      </ul>

      <div v-else class="card py-10 text-center">
        <p class="text-lg font-semibold text-fg-strong">Aucune chaîne déclarée</p>
        <p class="mx-auto mt-2 max-w-md text-sm text-fg-muted">
          Les membres peuvent relier leur chaîne Twitch depuis leur profil.
        </p>
        <router-link v-if="me.authenticated" to="/profil" class="btn-primary mt-4 text-sm">
          Lier ma chaîne Twitch
        </router-link>
        <a v-else href="/api/auth/discord" class="btn-primary mt-4 text-sm">
          Rejoindre le serveur
        </a>
      </div>

    </section>
  </div>
</template>
