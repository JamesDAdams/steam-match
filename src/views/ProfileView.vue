<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import {
  apiGet,
  apiPost,
  formatPlaytime,
  steamStoreUrl,
  steamHeaderUrl,
  hideBrokenImage,
} from '../lib/api';
import { useAuth } from '../lib/auth';

interface ProfileGame {
  appid: number;
  name: string;
  headerImage: string | null;
  genres: string[];
  tags: string[];
  enriched: boolean;
  playtime: number;
  playtime2Weeks: number;
}

interface Stats {
  totalGames: number;
  playedGames: number;
  neverPlayed: number;
  totalMinutes: number;
  averageMinutes: number;
  enrichedGames: number;
  topGenres: { name: string; minutes: number; games: number }[];
}

const { me, displayName, refresh } = useAuth();

const games = ref<ProfileGame[]>([]);
const stats = ref<Stats | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);
const syncing = ref(false);
const enrichBusy = ref(false);

// Filtres
const search = ref('');
const sortBy = ref<'playtime' | 'name' | 'recent'>('playtime');
const onlyPlayed = ref(false);
const selectedGenre = ref<string | null>(null);

async function load() {
  loading.value = true;
  error.value = null;
  try {
    const data = await apiGet<{
      ok: boolean;
      games: ProfileGame[] | null;
      stats: Stats | null;
    }>('/api/me', { games: '1' });
    games.value = data.games ?? [];
    stats.value = data.stats ?? null;
  } catch (e: any) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

const maxPlaytime = computed(() =>
  games.value.reduce((m, g) => Math.max(m, g.playtime), 0),
);

const genres = computed(() => {
  const counts = new Map<string, number>();
  for (const g of games.value) {
    for (const genre of g.genres) counts.set(genre, (counts.get(genre) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([name, count]) => ({ name, count }));
});

const filtered = computed(() => {
  let list = games.value;

  if (onlyPlayed.value) list = list.filter((g) => g.playtime > 0);
  if (selectedGenre.value) {
    list = list.filter((g) => g.genres.includes(selectedGenre.value!));
  }

  const q = search.value.trim().toLowerCase();
  if (q) list = list.filter((g) => g.name.toLowerCase().includes(q));

  const sorted = [...list];
  if (sortBy.value === 'name') sorted.sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  else if (sortBy.value === 'recent') sorted.sort((a, b) => b.playtime2Weeks - a.playtime2Weeks);
  else sorted.sort((a, b) => b.playtime - a.playtime);

  return sorted;
});

/** Part du temps de jeu total représentée par un genre. */
function genreShare(minutes: number) {
  const total = stats.value?.totalMinutes ?? 0;
  if (!total) return 0;
  return Math.round((minutes / total) * 100);
}

async function sync() {
  syncing.value = true;
  error.value = null;
  try {
    const r = await apiPost<any>('/api/sync');
    if (!r.ok) error.value = r.message ?? 'Synchronisation impossible.';
    await refresh();
    await load();
  } catch (e: any) {
    error.value = e.message;
  } finally {
    syncing.value = false;
  }
}

async function enrich() {
  enrichBusy.value = true;
  try {
    await apiPost('/api/enrich');
    await load();
  } catch {
  } finally {
    enrichBusy.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div>
    <!-- En-tête de profil -->
    <section class="card mb-6">
      <div class="flex flex-wrap items-center gap-4">
        <img
          v-if="me.discord?.avatarUrl"
          :src="me.discord.avatarUrl"
          :alt="displayName"
          class="h-16 w-16 rounded-full border border-white/15"
        />
        <div
          v-else
          class="flex h-16 w-16 items-center justify-center rounded-full border border-white/15 bg-steam-navy text-xl font-bold text-steam-blue"
        >
          {{ displayName.slice(0, 1).toUpperCase() }}
        </div>

        <div class="min-w-0">
          <h1 class="text-2xl font-bold text-white">{{ displayName }}</h1>
          <p class="text-sm text-slate-400">
            <template v-if="me.discord">@{{ me.discord.username }}</template>
            <template v-if="me.steam">
              · Steam : <span class="text-slate-300">{{ me.steam.personaName }}</span>
            </template>
          </p>
          <p class="mt-1 text-xs text-slate-500">
            <template v-if="me.steam?.lastSyncAt">
              Dernière synchronisation :
              {{ new Date(me.steam.lastSyncAt).toLocaleString('fr-FR') }}
            </template>
            <template v-else>Jamais synchronisé</template>
          </p>
        </div>

        <div class="ml-auto flex gap-2">
          <button class="btn-ghost text-sm" :disabled="enrichBusy" @click="enrich">
            {{ enrichBusy ? 'Enrichissement…' : 'Enrichir les genres' }}
          </button>
          <button class="btn-primary text-sm" :disabled="syncing" @click="sync">
            {{ syncing ? 'Synchronisation…' : 'Synchroniser' }}
          </button>
        </div>
      </div>

      <p v-if="error" class="mt-3 text-sm text-red-300">{{ error }}</p>

      <p v-if="!me.steam" class="mt-3 text-sm text-amber-300">
        Aucun compte Steam relié — va sur l'accueil pour le relier.
      </p>
    </section>

    <!-- Aucune donnée -->
    <div v-if="!loading && me.steam && games.length === 0" class="card py-12 text-center">
      <p class="text-slate-400">Aucun jeu en base pour l'instant.</p>
      <button class="btn-primary mt-4 text-sm" :disabled="syncing" @click="sync">
        Synchroniser ma ludothèque
      </button>
    </div>

    <template v-else>
      <!-- Statistiques -->
      <section v-if="stats" class="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div class="card">
          <p class="text-xs uppercase tracking-wide text-slate-500">Jeux possédés</p>
          <p class="mt-1 text-2xl font-bold text-white">{{ stats.totalGames }}</p>
          <p class="text-xs text-slate-500">{{ stats.neverPlayed }} jamais lancés</p>
        </div>
        <div class="card">
          <p class="text-xs uppercase tracking-wide text-slate-500">Temps de jeu total</p>
          <p class="mt-1 text-2xl font-bold text-steam-blue">
            {{ formatPlaytime(stats.totalMinutes) }}
          </p>
          <p class="text-xs text-slate-500">{{ stats.playedGames }} jeux lancés</p>
        </div>
        <div class="card">
          <p class="text-xs uppercase tracking-wide text-slate-500">Temps moyen / jeu</p>
          <p class="mt-1 text-2xl font-bold text-white">
            {{ formatPlaytime(stats.averageMinutes) }}
          </p>
          <p class="text-xs text-slate-500">sur les jeux joués</p>
        </div>
        <div class="card">
          <p class="text-xs uppercase tracking-wide text-slate-500">Genres identifiés</p>
          <p class="mt-1 text-2xl font-bold text-white">{{ stats.enrichedGames }}</p>
          <p class="text-xs text-slate-500">jeux enrichis</p>
        </div>
      </section>

      <!-- Goûts par genre -->
      <section v-if="stats && stats.topGenres.length" class="card mb-6">
        <h2 class="font-semibold text-white">Tes styles de jeu</h2>
        <p class="mt-1 text-xs text-slate-500">
          Pondéré par le temps de jeu : ce n'est pas le nombre de jeux possédés,
          mais le temps réellement passé.
        </p>
        <div class="mt-4 space-y-2">
          <div
            v-for="g in stats.topGenres"
            :key="g.name"
            class="flex items-center gap-3 text-sm"
          >
            <span class="w-36 shrink-0 truncate text-slate-300">{{ g.name }}</span>
            <div class="h-2 flex-1 overflow-hidden rounded bg-white/10">
              <div
                class="h-full rounded bg-steam-blue/70"
                :style="{ width: genreShare(g.minutes) + '%' }"
              ></div>
            </div>
            <span class="w-20 shrink-0 text-right text-xs text-slate-500">
              {{ formatPlaytime(g.minutes) }}
            </span>
          </div>
        </div>
      </section>

      <!-- Filtres -->
      <section class="card mb-6">
        <div class="flex flex-wrap items-center gap-3">
          <input
            v-model="search"
            placeholder="Rechercher un jeu…"
            class="min-w-[12rem] flex-1 rounded border border-white/15 bg-steam-darker px-3 py-1.5 text-sm text-slate-200 placeholder:text-slate-600 focus:border-steam-blue focus:outline-none"
          />
          <select
            v-model="sortBy"
            class="rounded border border-white/15 bg-steam-darker px-3 py-1.5 text-sm text-slate-200"
          >
            <option value="playtime">Temps de jeu</option>
            <option value="name">Nom (A→Z)</option>
            <option value="recent">Joués récemment</option>
          </select>
          <label class="flex items-center gap-2 text-sm text-slate-300">
            <input v-model="onlyPlayed" type="checkbox" class="rounded border-white/20 bg-steam-darker" />
            Joués seulement
          </label>
          <button
            v-if="selectedGenre || search || onlyPlayed"
            class="text-xs text-slate-400 hover:text-white"
            @click="((selectedGenre = null), (search = ''), (onlyPlayed = false))"
          >
            Réinitialiser
          </button>
        </div>

        <div v-if="genres.length" class="mt-3 flex flex-wrap gap-2">
          <button
            v-for="g in genres"
            :key="g.name"
            class="chip"
            :class="{ 'chip-active': selectedGenre === g.name }"
            @click="selectedGenre = selectedGenre === g.name ? null : g.name"
          >
            {{ g.name }}
            <span class="ml-1 text-[10px] opacity-60">{{ g.count }}</span>
          </button>
        </div>
      </section>

      <!-- Liste des jeux -->
      <div v-if="loading" class="grid gap-3 sm:grid-cols-2">
        <div v-for="i in 8" :key="i" class="h-20 animate-pulse rounded-lg bg-white/5"></div>
      </div>

      <div v-else-if="filtered.length === 0" class="card py-10 text-center text-slate-400">
        Aucun jeu ne correspond à ces filtres.
      </div>

      <div v-else class="space-y-2">
        <a
          v-for="g in filtered"
          :key="g.appid"
          :href="steamStoreUrl(g.appid)"
          target="_blank"
          rel="noopener"
          class="card flex items-center gap-4 p-2 transition hover:border-steam-blue/40"
        >
          <div class="h-14 w-32 shrink-0 overflow-hidden rounded bg-steam-navy/40">
            <img
              :src="g.headerImage || steamHeaderUrl(g.appid)"
              :alt="g.name"
              loading="lazy"
              class="h-full w-full object-cover"
              @error="hideBrokenImage"
            />
          </div>

          <div class="min-w-0 flex-1">
            <div class="flex items-baseline gap-2">
              <p class="truncate text-sm font-medium text-white">{{ g.name }}</p>
              <span v-if="g.playtime2Weeks > 0" class="badge bg-emerald-500/20 text-emerald-300">
                récent
              </span>
            </div>

            <div class="mt-1 flex flex-wrap gap-1">
              <span v-for="genre in g.genres.slice(0, 3)" :key="genre" class="badge bg-steam-navy/60 text-steam-blue">
                {{ genre }}
              </span>
              <span v-if="!g.enriched" class="badge bg-white/10 text-slate-500">genres ?</span>
            </div>

            <div class="mt-1.5 h-1 overflow-hidden rounded bg-white/10">
              <div
                class="h-full rounded bg-steam-blue/70"
                :style="{ width: maxPlaytime ? (g.playtime / maxPlaytime) * 100 + '%' : '0%' }"
              ></div>
            </div>
          </div>

          <div class="shrink-0 text-right">
            <p class="text-sm font-semibold text-slate-200">{{ formatPlaytime(g.playtime) }}</p>
            <p v-if="g.playtime === 0" class="text-[10px] text-slate-600">jamais lancé</p>
            <p v-else-if="g.playtime2Weeks > 0" class="text-[10px] text-emerald-400/80">
              +{{ formatPlaytime(g.playtime2Weeks) }} ces 15 j
            </p>
          </div>
        </a>
      </div>

      <p v-if="filtered.length" class="mt-6 text-center text-xs text-slate-600">
        {{ filtered.length }} jeu{{ filtered.length > 1 ? 'x' : '' }} affiché{{ filtered.length > 1 ? 's' : '' }}
        <template v-if="games.length !== filtered.length"> sur {{ games.length }}</template>
      </p>
    </template>
  </div>
</template>
