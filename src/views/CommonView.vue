<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import {
  apiGet,
  apiPost,
  formatPlaytime,
  steamStoreUrl,
  steamHeaderUrl,
  hideBrokenImage,
  formatPrice,
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
  cheapestPrice?: number | null;
  cheapestStore?: string | null;
  cheapestCurrency?: string | null;
  steamPrice?: number | null;
  steamInitialPrice?: number | null;
  steamDiscount?: number | null;
  steamCurrency?: string | null;
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
const cacheState = ref<{ total: number; enriched: number; pending: number } | null>(null);

// Mode : jeux possédés en commun, ou wishlist croisée
const mode = ref<'owned' | 'wishlist'>('owned');
const playableOnly = ref(false);
const wishMessage = ref<string | null>(null);

// Filtres
const selectedGenres = ref<string[]>([]);
const selectedTags = ref<string[]>([]);
const minMembers = ref(2);
/**
 * Le seuil n'a pas le même sens selon le mode : « possédé par au moins N »
 * pour la ludothèque, « souhaité par au moins N » pour la wishlist. Avec un
 * seul membre qui a une wishlist, un seuil à 2 ne peut rien renvoyer — d'où
 * un message trompeur « aucune wishlist synchronisée ».
 */
watch(mode, (m) => {
  minMembers.value = m === 'wishlist' ? 1 : 2;
});
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
    await load();
    await loadGroup();
  } catch (e: any) {
    syncResult.value = { ok: false, error: e.message };
  } finally {
    syncing.value = false;
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

/* ── Mise à jour automatique pendant l'enrichissement ──────────────── */

/**
 * Tant qu'il reste des jeux à enrichir, la page se rafraîchit seule : sinon il
 * fallait recharger à la main pour voir la barre avancer et les filtres se
 * remplir.
 */
const REFRESH_MS = 5_000;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

function stopAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

function startAutoRefresh() {
  if (refreshTimer) return;
  refreshTimer = setInterval(async () => {
    if (document.hidden) return;
    await loadGroup();
    if ((cacheState.value?.pending ?? 0) === 0) {
      stopAutoRefresh();
      return;
    }
    await load();
  }, REFRESH_MS);
}

onMounted(async () => {
  await Promise.all([load(), loadGroup()]);
  if ((cacheState.value?.pending ?? 0) > 0) startAutoRefresh();
});

onUnmounted(stopAutoRefresh);
</script>

<template>
  <div>
    <!-- Barre d'actions -->
    <div class="mb-6 flex flex-wrap items-center gap-3">
      <h1 class="text-2xl font-bold text-fg-strong">Jeux en commun</h1>
      <span class="text-sm text-fg-faint">
        {{ memberCount }} membre{{ memberCount > 1 ? 's' : '' }} dans le groupe
      </span>

      <div class="flex rounded border border-line p-0.5 text-sm">
        <button
          class="rounded px-3 py-1 transition"
          :class="mode === 'owned' ? 'bg-brand-soft text-brand' : 'text-fg-muted hover:text-fg-strong'"
          @click="mode = 'owned'"
        >
          Possédés
        </button>
        <button
          class="rounded px-3 py-1 transition"
          :class="mode === 'wishlist' ? 'bg-brand-soft text-brand' : 'text-fg-muted hover:text-fg-strong'"
          @click="mode = 'wishlist'"
        >
          Wishlist
        </button>
      </div>

      <div class="ml-auto flex gap-2">
        <button class="btn-primary text-sm" :disabled="syncing" @click="sync">
          <span v-if="syncing">Synchronisation…</span>
          <span v-else>Synchroniser mon Steam</span>
        </button>
      </div>
    </div>

    <!-- Retour du sync -->
    <div v-if="syncResult" class="card mb-6" :class="syncResult.ok ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-danger bg-danger-soft'">
      <template v-if="syncResult.ok">
        <p class="text-sm text-ok">
          ✅ {{ syncResult.gamesCount }} jeux synchronisés
          <template v-if="syncResult.playedCount">
            — {{ syncResult.playedCount }} avec temps de jeu
          </template>
        </p>
        <p v-if="syncResult.warning" class="mt-2 text-sm text-warn">
          ⚠️ {{ syncResult.warning }}
        </p>
      </template>
      <template v-else>
        <p class="text-sm text-danger">
          ❌ {{ syncResult.message || syncResult.error }}
        </p>
        <div v-if="syncResult.needsPublicProfile" class="mt-2 flex flex-wrap gap-3">
          <a
            href="https://steamcommunity.com/my/edit/settings"
            target="_blank"
            rel="noopener"
            class="text-sm text-brand hover:underline"
          >
            Ouvrir mes paramètres de confidentialité Steam ↗
          </a>
          <router-link to="/aide" class="text-sm text-fg-muted hover:underline">
            Voir le guide pas à pas
          </router-link>
        </div>
      </template>
    </div>

    <!-- Progression de l'enrichissement -->
    <div v-if="cacheState && cacheState.pending > 0" class="card mb-6">
      <div class="flex items-center justify-between text-sm">
        <span class="text-fg">
          Enrichissement des genres — {{ cacheState.enriched }} / {{ cacheState.total }} jeux
        </span>
        <span class="text-brand">{{ enrichmentPct }} %</span>
      </div>
      <div class="mt-2 h-2 overflow-hidden rounded bg-app-surface2">
        <div class="stripes h-full rounded bg-brand/60 transition-all" :style="{ width: enrichmentPct + '%' }"></div>
      </div>
      <p class="mt-2 text-xs text-fg-faint">
        Les métadonnées (noms, genres, prix) se remplissent automatiquement en
        arrière-plan. Rien à faire : les filtres se complètent au fil des minutes.
      </p>
    </div>

    <!-- Explication wishlist -->
    <div v-if="mode === 'wishlist'" class="card mb-6 border-white/5 text-xs text-fg-muted">
      Les jeux <strong class="text-fg">souhaités</strong> par les membres, croisés avec
      ce que les autres possèdent déjà. Un jeu « jouable » est déjà dans la
      bibliothèque de quelqu'un : pas besoin de l'acheter pour y jouer ensemble.
    </div>

    <!-- Filtres -->
    <div class="card mb-6">
      <div class="flex flex-wrap items-end gap-4">
        <div>
          <label class="block text-xs font-medium text-fg-muted">
            {{ mode === 'wishlist' ? 'Souhaité par au moins' : 'Possédé par au moins' }}
          </label>
          <select v-model.number="minMembers" class="mt-1 rounded border border-line bg-app-bg px-3 py-1.5 text-sm text-fg">
            <option v-if="mode === 'wishlist'" :value="1">1 membre</option>
            <option :value="2">2 membres</option>
            <option :value="3">3 membres</option>
            <option :value="4">4 membres</option>
            <option :value="5">5 membres</option>
            <option :value="6">6 membres</option>
          </select>
        </div>
        <div>
          <label class="block text-xs font-medium text-fg-muted">Trier par</label>
          <select v-model="sortBy" class="mt-1 rounded border border-line bg-app-bg px-3 py-1.5 text-sm text-fg">
            <option value="players">Nombre de possesseurs</option>
            <option value="playtime">Temps de jeu cumulé</option>
            <option value="name">Nom (A→Z)</option>
          </select>
        </div>
        <label v-if="mode === 'owned'" class="flex items-center gap-2 text-sm text-fg">
          <input v-model="onlyEnriched" type="checkbox" class="rounded border-line-strong bg-app-bg" />
          Masquer les jeux non enrichis
        </label>
        <label v-if="mode === 'wishlist'" class="flex items-center gap-2 text-sm text-fg">
          <input v-model="playableOnly" type="checkbox" class="rounded border-line-strong bg-app-bg" />
          Jouable immédiatement (déjà possédé)
        </label>
        <button v-if="selectedGenres.length || selectedTags.length" class="btn-ghost text-xs" @click="resetFilters">
          Réinitialiser les filtres
        </button>
      </div>

      <!-- Genres -->
      <div v-if="availableGenres.length" class="mt-4">
        <p class="mb-2 text-xs font-medium text-fg-muted">Style / genre</p>
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
        <p class="mb-2 text-xs font-medium text-fg-muted">Tags</p>
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
    <div v-if="mode === 'wishlist' && wishMessage" class="card mb-6 border-brand bg-brand-soft text-sm text-fg">
      {{ wishMessage }}
    </div>

    <!-- Erreur -->
    <div v-if="error" class="card border-danger bg-danger-soft text-sm text-danger">
      {{ error }}
    </div>

    <!-- Résultats -->
    <div v-if="loading" class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <div v-for="i in 9" :key="i" class="h-48 animate-pulse rounded-lg bg-app-surface2"></div>
    </div>

    <div v-else-if="games.length === 0" class="card py-12 text-center">
      <p class="text-fg-muted">Aucun jeu ne correspond à ces critères.</p>
      <p class="mt-2 text-sm text-fg-faint">
        Synchronise ta ludothèque, ou élargis les filtres.
      </p>
    </div>

    <div v-else class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <article v-for="g in games" :key="g.appid" class="card group overflow-hidden p-0">
        <a :href="steamStoreUrl(g.appid)" target="_blank" rel="noopener" class="block">
          <div class="relative aspect-[92/43] overflow-hidden bg-app-surface2">
            <img
              :src="g.headerImage || steamHeaderUrl(g.appid)"
              :alt="g.name"
              loading="lazy"
              class="h-full w-full object-cover transition group-hover:scale-105"
              @error="hideBrokenImage"
            />
            <span class="badge absolute left-2 top-2 bg-app-bg/85 text-brand">
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
            <span v-if="!g.enriched" class="badge absolute right-2 top-2 bg-app-bg/85 text-fg-muted">
              genres ?
            </span>
          </div>

          <div class="p-3">
            <h3 class="truncate font-semibold text-fg-strong" :title="g.name">{{ g.name }}</h3>

            <div v-if="g.genres.length" class="mt-2 flex flex-wrap gap-1">
              <span v-for="gen in g.genres.slice(0, 3)" :key="gen" class="badge bg-app-surface2 text-brand">
                {{ gen }}
              </span>
            </div>

            <div class="mt-3 flex items-center justify-between text-xs text-fg-muted">
              <span class="flex items-center gap-1">
                🕐 {{ formatPlaytime(g.totalPlaytime) }}
              </span>
              <span v-if="mode === 'wishlist'" class="truncate" :title="(g.owners ?? []).join(', ')">
                <template v-if="g.ownerCount">
                  possédé par {{ (g.owners ?? []).slice(0, 2).join(', ') }}<template v-if="(g.ownerCount ?? 0) > 2"> +{{ (g.ownerCount ?? 0) - 2 }}</template>
                </template>
                <template v-else>personne ne l'a encore</template>
              </span>
              <span
                v-if="mode === 'wishlist' && g.steamPrice"
                class="text-fg-muted"
                title="Prix officiel Steam"
              >
                Steam {{ formatPrice(g.steamPrice, g.steamCurrency ?? 'EUR') }}
              </span>
              <span
                v-if="mode === 'wishlist' && g.cheapestPrice"
                class="text-gold"
                :title="g.cheapestStore ?? undefined"
              >
                clé dès {{ formatPrice(g.cheapestPrice, g.cheapestCurrency ?? 'EUR') }}
              </span>
              <span v-else class="truncate" :title="g.players.join(', ')">
                {{ g.players.slice(0, 2).join(', ') }}<template v-if="g.players.length > 2"> +{{ g.players.length - 2 }}</template>
              </span>
            </div>
          </div>
        </a>
      </article>
    </div>

    <p v-if="total > 0" class="mt-6 text-center text-sm text-fg-faint">
      {{ total }} jeu{{ total > 1 ? 'x' : '' }} affiché{{ total > 1 ? 's' : '' }}
    </p>
  </div>
</template>
