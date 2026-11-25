<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import {
  apiGet,
  apiPost,
  formatPlaytime,
  steamStoreUrl,
  steamHeaderUrl,
  hideBrokenImage,
} from '../lib/api';

interface Game {
  appid: number;
  name: string;
  headerImage: string | null;
  genres: string[];
  tags: string[];
  enriched: boolean;
  owners: number;
  totalPlaytime: number;
  minPlaytime: number;
  players: string[];
  // Champs présents uniquement en mode wishlist
  wishCount?: number;
  wishers?: string[];
  ownerCount?: number;
  owners?: string[];
  playableNow?: boolean;
}

const games = ref<Game[]>([]);
const total = ref(0);
const memberCount = ref(0);
const genreCounts = ref<Record<string, number>>({});
const loading = ref(true);
const error = ref<string | null>(null);

// Synchronisation
const syncing = ref(false);
const syncResult = ref<any>(null);
const enriching = ref(false);
const cacheState = ref<{ total: number; enriched: number; pending: number } | null>(null);

// Mode : jeux possédés en commun, ou wishlist croisée
const mode = ref<'owned' | 'wishlist'>('owned');
const playableOnly = ref(false);
const wishMessage = ref<string | null>(null);

// Filtres
const selectedGenres = ref<string[]>([]);
const selectedTags = ref<string[]>([]);
const minMembers = ref(2);
const sortBy = ref<'players' | 'playtime' | 'name'>('players');
const onlyEnriched = ref(false);

const availableGenres = computed(() =>
  Object.entries(genreCounts.value)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count })),
);

const availableTags = computed(() => {
  const counts: Record<string, number> = {};
  for (const g of games.value) {
    for (const t of g.tags) counts[t] = (counts[t] ?? 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 40);
});

const enrichmentPct = computed(() => {
  if (!cacheState.value || cacheState.value.total === 0) return 0;
  return Math.round((cacheState.value.enriched / cacheState.value.total) * 100);
});

async function load() {
  loading.value = true;
  error.value = null;
  try {
    const data = await apiGet<{
      ok: boolean;
      games: Game[];
      total: number;
      memberCount: number;
      genreCounts: Record<string, number>;
    }>('/api/common', {
      mode: mode.value === 'wishlist' ? 'wishlist' : undefined,
      playable: mode.value === 'wishlist' && playableOnly.value ? '1' : undefined,
      genres: mode.value === 'owned' ? selectedGenres.value.join(',') || undefined : undefined,
      tags: selectedTags.value.join(',') || undefined,
      min: minMembers.value,
      sort: sortBy.value,
      enriched: onlyEnriched.value ? '1' : undefined,
    });
    games.value = data.games ?? [];
    total.value = data.total ?? 0;
    memberCount.value = data.memberCount ?? 0;
    wishMessage.value = (data as any).message ?? null;
    // Les facettes sont calculées sur l'ensemble, pas sur le résultat filtré,
    // sinon les genres disparaissent dès qu'on en sélectionne un.
    genreCounts.value = data.genreCounts ?? {};
  } catch (e: any) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

async function loadGroup() {
  try {
    const g = await apiGet<{ cache: any }>('/api/group');
    cacheState.value = g.cache ?? null;
  } catch {}
}

async function sync() {
  syncing.value = true;
  syncResult.value = null;
  try {
    const r = await apiPost('/api/sync');
    syncResult.value = r;
    // Enchaîne un peu d'enrichissement juste après le sync.
    await enrich();
    await load();
    await loadGroup();
  } catch (e: any) {
    syncResult.value = { ok: false, error: e.message };
  } finally {
    syncing.value = false;
  }
}

async function enrich() {
  enriching.value = true;
  try {
    await apiPost('/api/enrich');
    await loadGroup();
  } catch {
  } finally {
    enriching.value = false;
  }
}

function toggleGenre(g: string) {
  const i = selectedGenres.value.indexOf(g);
  if (i >= 0) selectedGenres.value.splice(i, 1);
  else selectedGenres.value.push(g);
}

function toggleTag(t: string) {
  const i = selectedTags.value.indexOf(t);
  if (i >= 0) selectedTags.value.splice(i, 1);
  else selectedTags.value.push(t);
}

function resetFilters() {
  selectedGenres.value = [];
  selectedTags.value = [];
  minMembers.value = 2;
  sortBy.value = 'players';
  onlyEnriched.value = false;
}

let debounceTimer: ReturnType<typeof setTimeout>;
watch([selectedGenres, selectedTags, minMembers, sortBy, onlyEnriched, mode, playableOnly], () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(load, 250);
});

onMounted(async () => {
  await Promise.all([load(), loadGroup()]);
});
</script>

<template>
  <div>
    <!-- Barre d'actions -->
    <div class="mb-6 flex flex-wrap items-center gap-3">
      <h1 class="text-2xl font-bold text-white">Jeux en commun</h1>
      <span class="text-sm text-slate-500">
        {{ memberCount }} membre{{ memberCount > 1 ? 's' : '' }} dans le groupe
      </span>

      <div class="flex rounded border border-white/15 p-0.5 text-sm">
        <button
          class="rounded px-3 py-1 transition"
          :class="mode === 'owned' ? 'bg-steam-blue/15 text-steam-blue' : 'text-slate-400 hover:text-white'"
          @click="mode = 'owned'"
        >
          Possédés
        </button>
        <button
          class="rounded px-3 py-1 transition"
          :class="mode === 'wishlist' ? 'bg-steam-blue/15 text-steam-blue' : 'text-slate-400 hover:text-white'"
          @click="mode = 'wishlist'"
        >
          Wishlist
        </button>
      </div>

      <div class="ml-auto flex gap-2">
        <button class="btn-ghost text-sm" :disabled="enriching" @click="enrich">
          <span v-if="enriching">Enrichissement…</span>
          <span v-else>Enrichir les genres</span>
        </button>
        <button class="btn-primary text-sm" :disabled="syncing" @click="sync">
          <span v-if="syncing">Synchronisation…</span>
          <span v-else>Synchroniser mon Steam</span>
        </button>
      </div>
    </div>

    <!-- Retour du sync -->
    <div v-if="syncResult" class="card mb-6" :class="syncResult.ok ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-red-500/40 bg-red-500/5'">
      <template v-if="syncResult.ok">
        <p class="text-sm text-emerald-300">
          ✅ {{ syncResult.gamesCount }} jeux synchronisés
          <template v-if="syncResult.playedCount">
            — {{ syncResult.playedCount }} avec temps de jeu
          </template>
        </p>
        <p v-if="syncResult.warning" class="mt-2 text-sm text-amber-300">
          ⚠️ {{ syncResult.warning }}
        </p>
      </template>
      <template v-else>
        <p class="text-sm text-red-300">
          ❌ {{ syncResult.message || syncResult.error }}
        </p>
        <div v-if="syncResult.needsPublicProfile" class="mt-2 flex flex-wrap gap-3">
          <a
            href="https://steamcommunity.com/my/edit/settings"
            target="_blank"
            rel="noopener"
            class="text-sm text-steam-blue hover:underline"
          >
            Ouvrir mes paramètres de confidentialité Steam ↗
          </a>
          <router-link to="/aide" class="text-sm text-slate-400 hover:underline">
            Voir le guide pas à pas
          </router-link>
        </div>
      </template>
    </div>

    <!-- Progression de l'enrichissement -->
    <div v-if="cacheState && cacheState.pending > 0" class="card mb-6">
      <div class="flex items-center justify-between text-sm">
        <span class="text-slate-300">
          Enrichissement des genres — {{ cacheState.enriched }} / {{ cacheState.total }} jeux
        </span>
        <span class="text-steam-blue">{{ enrichmentPct }} %</span>
      </div>
      <div class="mt-2 h-2 overflow-hidden rounded bg-white/10">
        <div class="stripes h-full rounded bg-steam-blue/60 transition-all" :style="{ width: enrichmentPct + '%' }"></div>
      </div>
      <p class="mt-2 text-xs text-slate-500">
        Les genres viennent de l'API du Store Steam, limitée à ~200 requêtes
        par 5 min. Les filtres se remplissent donc progressivement. Les jeux
        non enrichis ne matchent aucun filtre de genre.
      </p>
    </div>

    <!-- Explication wishlist -->
    <div v-if="mode === 'wishlist'" class="card mb-6 border-white/5 text-xs text-slate-400">
      Les jeux <strong class="text-slate-200">souhaités</strong> par les membres, croisés avec
      ce que les autres possèdent déjà. Un jeu « jouable » est déjà dans la
      bibliothèque de quelqu'un : pas besoin de l'acheter pour y jouer ensemble.
    </div>

    <!-- Filtres -->
    <div class="card mb-6">
      <div class="flex flex-wrap items-end gap-4">
        <div>
          <label class="block text-xs font-medium text-slate-400">Possédé par au moins</label>
          <select v-model.number="minMembers" class="mt-1 rounded border border-white/15 bg-steam-darker px-3 py-1.5 text-sm text-slate-200">
            <option :value="2">2 membres</option>
            <option :value="3">3 membres</option>
            <option :value="4">4 membres</option>
            <option :value="5">5 membres</option>
            <option :value="6">6 membres</option>
          </select>
        </div>
        <div>
          <label class="block text-xs font-medium text-slate-400">Trier par</label>
          <select v-model="sortBy" class="mt-1 rounded border border-white/15 bg-steam-darker px-3 py-1.5 text-sm text-slate-200">
            <option value="players">Nombre de possesseurs</option>
            <option value="playtime">Temps de jeu cumulé</option>
            <option value="name">Nom (A→Z)</option>
          </select>
        </div>
        <label v-if="mode === 'owned'" class="flex items-center gap-2 text-sm text-slate-300">
          <input v-model="onlyEnriched" type="checkbox" class="rounded border-white/20 bg-steam-darker" />
          Masquer les jeux non enrichis
        </label>
        <label v-if="mode === 'wishlist'" class="flex items-center gap-2 text-sm text-slate-300">
          <input v-model="playableOnly" type="checkbox" class="rounded border-white/20 bg-steam-darker" />
          Jouable immédiatement (déjà possédé)
        </label>
        <button v-if="selectedGenres.length || selectedTags.length" class="btn-ghost text-xs" @click="resetFilters">
          Réinitialiser les filtres
        </button>
      </div>

      <!-- Genres -->
      <div v-if="availableGenres.length" class="mt-4">
        <p class="mb-2 text-xs font-medium text-slate-400">Style / genre</p>
        <div class="flex flex-wrap gap-2">
          <button
            v-for="g in availableGenres"
            :key="g.name"
            class="chip"
            :class="{ 'chip-active': selectedGenres.includes(g.name) }"
            @click="toggleGenre(g.name)"
          >
            {{ g.name }}
            <span class="ml-1 text-[10px] opacity-60">{{ g.count }}</span>
          </button>
        </div>
      </div>

      <!-- Tags -->
      <div v-if="availableTags.length" class="mt-4">
        <p class="mb-2 text-xs font-medium text-slate-400">Tags</p>
        <div class="flex flex-wrap gap-2">
          <button
            v-for="[t, c] in availableTags.slice(0, 30)"
            :key="t"
            class="chip"
            :class="{ 'chip-active': selectedTags.includes(t) }"
            @click="toggleTag(t)"
          >
            {{ t }}
            <span class="ml-1 text-[10px] opacity-60">{{ c }}</span>
          </button>
        </div>
      </div>
    </div>

    <!-- Message wishlist -->
    <div v-if="mode === 'wishlist' && wishMessage" class="card mb-6 border-sky-500/30 bg-sky-500/5 text-sm text-sky-200">
      {{ wishMessage }}
    </div>

    <!-- Erreur -->
    <div v-if="error" class="card border-red-500/40 bg-red-500/5 text-sm text-red-300">
      {{ error }}
    </div>

    <!-- Résultats -->
    <div v-if="loading" class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <div v-for="i in 9" :key="i" class="h-48 animate-pulse rounded-lg bg-white/5"></div>
    </div>

    <div v-else-if="games.length === 0" class="card py-12 text-center">
      <p class="text-slate-400">Aucun jeu ne correspond à ces critères.</p>
      <p class="mt-2 text-sm text-slate-500">
        Synchronise ta ludothèque, ou élargis les filtres.
      </p>
    </div>

    <div v-else class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <article v-for="g in games" :key="g.appid" class="card group overflow-hidden p-0">
        <a :href="steamStoreUrl(g.appid)" target="_blank" rel="noopener" class="block">
          <div class="relative aspect-[92/43] overflow-hidden bg-steam-navy/40">
            <img
              :src="g.headerImage || steamHeaderUrl(g.appid)"
              :alt="g.name"
              loading="lazy"
              class="h-full w-full object-cover transition group-hover:scale-105"
              @error="hideBrokenImage"
            />
            <span class="badge absolute left-2 top-2 bg-black/70 text-steam-blue">
              <template v-if="mode === 'wishlist'">
                {{ g.wishCount }} souhait{{ (g.wishCount ?? 0) > 1 ? 'ent' : '' }}
              </template>
              <template v-else>{{ g.owners }} / {{ memberCount }}</template>
            </span>
            <span
              v-if="mode === 'wishlist' && g.playableNow"
              class="badge absolute right-2 top-2 bg-emerald-500/90 text-black"
            >
              jouable
            </span>
            <span v-if="!g.enriched" class="badge absolute right-2 top-2 bg-black/70 text-slate-400">
              genres ?
            </span>
          </div>

          <div class="p-3">
            <h3 class="truncate font-semibold text-white" :title="g.name">{{ g.name }}</h3>

            <div v-if="g.genres.length" class="mt-2 flex flex-wrap gap-1">
              <span v-for="gen in g.genres.slice(0, 3)" :key="gen" class="badge bg-steam-navy/60 text-steam-blue">
                {{ gen }}
              </span>
            </div>

            <div class="mt-3 flex items-center justify-between text-xs text-slate-400">
              <span class="flex items-center gap-1">
                🕐 {{ formatPlaytime(g.totalPlaytime) }}
              </span>
              <span v-if="mode === 'wishlist'" class="truncate" :title="(g.owners ?? []).join(', ')">
                <template v-if="g.ownerCount">
                  possédé par {{ (g.owners ?? []).slice(0, 2).join(', ') }}<template v-if="(g.ownerCount ?? 0) > 2"> +{{ (g.ownerCount ?? 0) - 2 }}</template>
                </template>
                <template v-else>personne ne l'a encore</template>
              </span>
              <span v-else class="truncate" :title="g.players.join(', ')">
                {{ g.players.slice(0, 2).join(', ') }}<template v-if="g.players.length > 2"> +{{ g.players.length - 2 }}</template>
              </span>
            </div>
          </div>
        </a>
      </article>
    </div>

    <p v-if="total > 0" class="mt-6 text-center text-sm text-slate-500">
      {{ total }} jeu{{ total > 1 ? 'x' : '' }} affiché{{ total > 1 ? 's' : '' }}
    </p>
  </div>
</template>
