<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import {
  apiGet,
  apiPost,
  formatPlaytime,
  steamStoreUrl,
  steamHeaderUrl,
  hideBrokenImage,
  formatPrice,
  ggDealsUrl,
  reviewLabel,
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
  cheapestPrice: number | null;
  cheapestStore: string | null;
  cheapestCurrency: string | null;
  steamPrice: number | null;
  steamInitialPrice: number | null;
  steamDiscount: number | null;
  steamCurrency: string | null;
  reviewScore: number | null;
  reviewPositive: number | null;
  reviewNegative: number | null;
  releaseDate: string | null;
  playModes: string[];
}

interface WishItem {
  appid: number;
  name: string;
  headerImage: string | null;
  genres: string[];
  playableNow: boolean;
  owners: string[];
  cheapestPrice: number | null;
  cheapestStore: string | null;
  cheapestCurrency: string | null;
  steamPrice: number | null;
  steamInitialPrice: number | null;
  steamDiscount: number | null;
  steamCurrency: string | null;
  reviewScore: number | null;
  reviewPositive: number | null;
  reviewNegative: number | null;
  releaseDate: string | null;
  playModes: string[];
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
const wishlist = ref<WishItem[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const syncing = ref(false);
const refreshing = ref(false);

// Filtres
const search = ref('');
const sortBy = ref<'playtime' | 'name' | 'recent'>('playtime');
const onlyPlayed = ref(false);
const selectedGenre = ref<string | null>(null);

/**
 * Onglet actif : la ludothèque ou la wishlist.
 * Les deux listes empilées devenaient illisibles (177 + 293 entrées).
 */
const tab = ref<'games' | 'wishlist'>('games');

async function load(silent = false) {
  if (!silent) loading.value = true;
  else refreshing.value = true;
  error.value = null;
  try {
    const data = await apiGet<{
      ok: boolean;
      games: ProfileGame[] | null;
      stats: Stats | null;
      wishlist: WishItem[] | null;
      steam?: { wishlistVisible?: boolean } | null;
    }>('/api/me', { games: '1' });
    games.value = data.games ?? [];
    stats.value = data.stats ?? null;
    wishlist.value = data.wishlist ?? [];
  } catch (e: any) {
    error.value = e.message;
  } finally {
    loading.value = false;
    refreshing.value = false;
  }
}

/** Jeux dont le nom n'est pas encore connu (affichés « App <id> »). */
const unidentifiedCount = computed(() => {
  const inWish = wishlist.value.filter((w) => /^App \d+$/.test(w.name)).length;
  const inGames = games.value.filter((g) => /^App \d+$/.test(g.name)).length;
  return inWish + inGames;
});

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

/**
 * MISE À JOUR À CHAUD
 * Tant qu'il reste des jeux non identifiés, l'enrichissement tourne en
 * arrière-plan (fonction planifiée Netlify). On recharge donc la page
 * périodiquement pour voir les noms, genres et prix apparaître, sans F5.
 *
 * La boucle s'arrête d'elle-même quand tout est identifié, et met en pause
 * quand l'onglet est en arrière-plan (économie de requêtes).
 */
const POLL_MS = 15_000;
let pollTimer: ReturnType<typeof setInterval> | null = null;

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    // Onglet inactif ou requête déjà en cours : on ne fait rien.
    if (document.hidden || refreshing.value) return;

    await load(true);

    // Plus rien à identifier : la boucle a rempli son rôle.
    if (unidentifiedCount.value === 0) stopPolling();
  }, POLL_MS);
}

/** Y a-t-il encore des données à rafraîchir automatiquement ? */
const autoUpdating = computed(
  () => pollTimer !== null && unidentifiedCount.value > 0,
);

onMounted(async () => {
  await load();
  if (unidentifiedCount.value > 0) startPolling();
});

onUnmounted(stopPolling);
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
          class="h-16 w-16 rounded-full border border-line"
        />
        <div
          v-else
          class="flex h-16 w-16 items-center justify-center rounded-full border border-line bg-app-surface2 text-xl font-bold text-brand"
        >
          {{ displayName.slice(0, 1).toUpperCase() }}
        </div>

        <div class="min-w-0">
          <h1 class="text-2xl font-bold text-fg-strong">{{ displayName }}</h1>
          <p class="text-sm text-fg-muted">
            <template v-if="me.discord">@{{ me.discord.username }}</template>
            <template v-if="me.steam">
              · Steam : <span class="text-fg">{{ me.steam.personaName }}</span>
            </template>
          </p>
          <p class="mt-1 text-xs text-fg-faint">
            <template v-if="me.steam?.lastSyncAt">
              Dernière synchronisation :
              {{ new Date(me.steam.lastSyncAt).toLocaleString('fr-FR') }}
            </template>
            <template v-else>Jamais synchronisé</template>
          </p>
        </div>

        <div class="ml-auto flex gap-2">
          <button class="btn-primary text-sm" :disabled="syncing" @click="sync">
            {{ syncing ? 'Synchronisation…' : 'Synchroniser' }}
          </button>
        </div>
      </div>

      <p v-if="error" class="mt-3 text-sm text-danger">{{ error }}</p>

      <p v-if="!me.steam" class="mt-3 text-sm text-warn">
        Aucun compte Steam relié — va sur l'accueil pour le relier.
      </p>
    </section>

    <!-- Aucune donnée -->
    <div v-if="!loading && me.steam && games.length === 0" class="card py-12 text-center">
      <p class="text-fg-muted">Aucun jeu en base pour l'instant.</p>
      <button class="btn-primary mt-4 text-sm" :disabled="syncing" @click="sync">
        Synchroniser ma ludothèque
      </button>
    </div>

    <template v-else>
      <!-- Jeux en cours d'identification -->
      <div v-if="unidentifiedCount > 0" class="alert alert-info mb-4">
        <div class="mb-1 flex items-center gap-2">
          <span class="relative flex h-2 w-2">
            <span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand opacity-75"></span>
            <span class="relative inline-flex h-2 w-2 rounded-full bg-brand"></span>
          </span>
          <span class="text-[11px] font-semibold uppercase tracking-wide">
            Mise à jour automatique
          </span>
          <span v-if="refreshing" class="text-[11px] text-fg-muted">actualisation…</span>
        </div>
        <p class="text-xs">
          <strong>{{ unidentifiedCount }} jeu(x)</strong> sont en cours d'identification
          et s'affichent provisoirement sous la forme « App 12345 ». Les noms,
          genres et prix se remplissent automatiquement en arrière-plan — rien
          à faire de ton côté, reviens un peu plus tard.
        </p>
      </div>

      <!-- Statistiques -->
      <section v-if="stats" class="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div class="card">
          <p class="text-xs uppercase tracking-wide text-fg-faint">Jeux possédés</p>
          <p class="mt-1 text-2xl font-bold text-fg-strong">{{ stats.totalGames }}</p>
          <p class="text-xs text-fg-faint">{{ stats.neverPlayed }} jamais lancés</p>
        </div>
        <div class="card">
          <p class="text-xs uppercase tracking-wide text-fg-faint">Temps de jeu total</p>
          <p class="mt-1 text-2xl font-bold text-brand">
            {{ formatPlaytime(stats.totalMinutes) }}
          </p>
          <p class="text-xs text-fg-faint">{{ stats.playedGames }} jeux lancés</p>
        </div>
        <div class="card">
          <p class="text-xs uppercase tracking-wide text-fg-faint">Temps moyen / jeu</p>
          <p class="mt-1 text-2xl font-bold text-fg-strong">
            {{ formatPlaytime(stats.averageMinutes) }}
          </p>
          <p class="text-xs text-fg-faint">sur les jeux joués</p>
        </div>
        <div class="card">
          <p class="text-xs uppercase tracking-wide text-fg-faint">Genres identifiés</p>
          <p class="mt-1 text-2xl font-bold text-fg-strong">{{ stats.enrichedGames }}</p>
          <p class="text-xs text-fg-faint">jeux enrichis</p>
        </div>
      </section>

      <!-- Goûts par genre -->
      <section v-if="stats && stats.topGenres.length" class="card mb-6">
        <h2 class="font-semibold text-fg-strong">Tes styles de jeu</h2>
        <p class="mt-1 text-xs text-fg-faint">
          Pondéré par le temps de jeu : ce n'est pas le nombre de jeux possédés,
          mais le temps réellement passé.
        </p>
        <div class="mt-4 space-y-2">
          <div
            v-for="g in stats.topGenres"
            :key="g.name"
            class="flex items-center gap-3 text-sm"
          >
            <span class="w-36 shrink-0 truncate text-fg">{{ g.name }}</span>
            <div class="h-2 flex-1 overflow-hidden rounded bg-app-surface2">
              <div
                class="h-full rounded bg-brand/70"
                :style="{ width: genreShare(g.minutes) + '%' }"
              ></div>
            </div>
            <span class="w-20 shrink-0 text-right text-xs text-fg-faint">
              {{ formatPlaytime(g.minutes) }}
            </span>
          </div>
        </div>
      </section>

      <!-- Sélecteur : ludothèque / wishlist -->
      <section class="mb-6 grid gap-4 sm:grid-cols-2">
        <button
          class="card-flat text-left transition hover:border-brand/50"
          :class="tab === 'games' ? '!border-brand ring-1 ring-brand/30' : ''"
          @click="tab = 'games'"
        >
          <div class="flex items-start justify-between gap-3">
            <div>
              <p class="text-xs uppercase tracking-wide text-fg-faint">Ma ludothèque</p>
              <p class="mt-1 font-display text-2xl font-bold text-fg-strong">
                {{ stats?.totalGames ?? 0 }}
              </p>
              <p class="mt-0.5 text-xs text-fg-muted">
                {{ formatPlaytime(stats?.totalMinutes ?? 0) }} jouées ·
                {{ stats?.playedGames ?? 0 }} lancés
              </p>
            </div>
            <span class="text-2xl">🎮</span>
          </div>
        </button>

        <button
          class="card-flat text-left transition hover:border-brand/50"
          :class="tab === 'wishlist' ? '!border-brand ring-1 ring-brand/30' : ''"
          @click="tab = 'wishlist'"
        >
          <div class="flex items-start justify-between gap-3">
            <div>
              <p class="text-xs uppercase tracking-wide text-fg-faint">Ma wishlist</p>
              <p class="mt-1 font-display text-2xl font-bold text-fg-strong">
                {{ wishlist.length }}
              </p>
              <p class="mt-0.5 text-xs text-fg-muted">
                <template v-if="wishlist.some((w) => w.playableNow)">
                  {{ wishlist.filter((w) => w.playableNow).length }} déjà jouable(s) dans le groupe
                </template>
                <template v-else>jeux souhaités</template>
              </p>
            </div>
            <span class="text-2xl">⭐</span>
          </div>
        </button>
      </section>

      <!-- Ma wishlist -->
      <section v-if="tab === 'wishlist' && wishlist.length" class="card mb-6">
        <div class="flex flex-wrap items-center gap-3">
          <h2 class="font-semibold text-fg-strong">Ma wishlist</h2>
          <span class="text-xs text-fg-faint">{{ wishlist.length }} jeu{{ wishlist.length > 1 ? 'x' : '' }} souhaité{{ wishlist.length > 1 ? 's' : '' }}</span>
          <span v-if="wishlist.some((w) => w.playableNow)" class="badge bg-ok-soft text-ok">
            {{ wishlist.filter((w) => w.playableNow).length }} déjà jouable(s) dans le groupe
          </span>
        </div>

        <div class="mt-4 space-y-2">
          <div
            v-for="w in wishlist"
            :key="w.appid"
            class="flex flex-col gap-3 rounded-lg border border-line p-3 transition hover:border-brand/40 sm:flex-row sm:items-center"
          >
            <!-- Jaquette -->
            <div class="h-16 w-32 shrink-0 overflow-hidden rounded bg-app-surface2">
              <img
                :src="w.headerImage || steamHeaderUrl(w.appid)"
                :alt="w.name"
                loading="lazy"
                class="h-full w-full object-cover"
                @error="hideBrokenImage"
              />
            </div>

            <!-- Informations -->
            <div class="min-w-0 flex-1">
              <p class="truncate font-medium text-fg-strong">{{ w.name }}</p>

              <div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
                <span
                  v-if="w.reviewScore !== null"
                  class="badge"
                  :class="{
                    'bg-ok-soft text-ok': reviewLabel(w.reviewScore).tone === 'ok',
                    'bg-warn-soft text-warn': reviewLabel(w.reviewScore).tone === 'warn',
                    'bg-danger-soft text-danger': reviewLabel(w.reviewScore).tone === 'danger',
                    'bg-app-surface2 text-fg-muted': reviewLabel(w.reviewScore).tone === 'muted',
                  }"
                  :title="`${w.reviewScore}% d'avis positifs`"
                >
                  {{ w.reviewScore }}% · {{ reviewLabel(w.reviewScore).text }}
                </span>
                <span v-if="w.releaseDate" class="text-fg-faint">{{ w.releaseDate }}</span>
                <span
                  v-for="m in w.playModes"
                  :key="m"
                  class="badge bg-app-surface2 text-fg-muted"
                >
                  {{ m }}
                </span>
                <span v-if="w.playableNow" class="text-ok">
                  possédé par {{ w.owners.slice(0, 2).join(', ') }}<template v-if="w.owners.length > 2"> +{{ w.owners.length - 2 }}</template>
                </span>
                <span v-else class="text-fg-faint">personne du groupe ne l'a</span>
              </div>
            </div>

            <!-- Prix -->
            <div class="shrink-0 text-left sm:text-right">
              <p v-if="w.steamPrice" class="text-xs text-fg-muted">
                Steam
                <span v-if="w.steamDiscount" class="ml-1 text-fg-faint line-through">
                  {{ formatPrice(w.steamInitialPrice ?? w.steamPrice, w.steamCurrency ?? 'EUR') }}
                </span>
                <span class="ml-1 font-medium text-fg-strong">
                  {{ formatPrice(w.steamPrice, w.steamCurrency ?? 'EUR') }}
                </span>
              </p>
              <p v-if="w.cheapestPrice" class="text-xs text-gold">
                Clé dès {{ formatPrice(w.cheapestPrice, w.cheapestCurrency ?? 'EUR') }}
                <span v-if="w.cheapestStore" class="text-fg-faint">· {{ w.cheapestStore }}</span>
              </p>
              <p v-if="!w.steamPrice && !w.cheapestPrice" class="text-[11px] text-fg-faint">
                prix bientôt disponible
              </p>
            </div>

            <!-- Actions -->
            <div class="flex shrink-0 gap-2">
              <a
                :href="ggDealsUrl(w.name)"
                target="_blank"
                rel="noopener"
                class="rounded-md border border-line-strong px-2.5 py-1.5 text-[11px] font-medium text-gold transition hover:bg-gold-soft"
                title="Comparer les prix des clés sur GG.deals"
              >
                Clés ↗
              </a>
              <a
                :href="steamStoreUrl(w.appid)"
                target="_blank"
                rel="noopener"
                class="rounded-md border border-line-strong px-2.5 py-1.5 text-[11px] font-medium text-fg transition hover:bg-app-surface2"
                title="Ouvrir la page Steam"
              >
                Steam ↗
              </a>
            </div>
          </div>
        </div>

        <p class="mt-3 text-xs text-fg-faint">
          La wishlist doit être publique dans tes paramètres Steam pour être
          synchronisée. Resynchronise après l'avoir modifiée.
        </p>
      </section>

      <!-- Wishlist vide -->
      <div v-if="tab === 'wishlist' && !wishlist.length" class="card py-12 text-center">
        <p class="text-lg font-semibold text-fg-strong">Aucun jeu dans ta wishlist</p>
        <p class="mx-auto mt-2 max-w-md text-sm text-fg-muted">
          La wishlist Steam doit être <strong class="text-fg">publique</strong> pour être
          synchronisée. Vérifie tes paramètres de confidentialité, puis resynchronise.
        </p>
        <button class="btn-primary mt-4 text-sm" :disabled="syncing" @click="sync">
          Synchroniser
        </button>
      </div>

      <!-- Filtres -->
      <section v-if="tab === 'games'" class="card mb-6">
        <div class="flex flex-wrap items-center gap-3">
          <input
            v-model="search"
            placeholder="Rechercher un jeu…"
            class="min-w-[12rem] flex-1 rounded border border-line bg-app-bg px-3 py-1.5 text-sm text-fg placeholder:text-fg-faint focus:border-brand focus:outline-none"
          />
          <select
            v-model="sortBy"
            class="rounded border border-line bg-app-bg px-3 py-1.5 text-sm text-fg"
          >
            <option value="playtime">Temps de jeu</option>
            <option value="name">Nom (A→Z)</option>
            <option value="recent">Joués récemment</option>
          </select>
          <label class="flex items-center gap-2 text-sm text-fg">
            <input v-model="onlyPlayed" type="checkbox" class="rounded border-line-strong bg-app-bg" />
            Joués seulement
          </label>
          <button
            v-if="selectedGenre || search || onlyPlayed"
            class="text-xs text-fg-muted hover:text-fg-strong"
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
      <div v-if="loading && tab === 'games'" class="grid gap-3 sm:grid-cols-2">
        <div v-for="i in 8" :key="i" class="h-20 animate-pulse rounded-lg bg-app-surface2"></div>
      </div>

      <div v-else-if="tab === 'games' && filtered.length === 0" class="card py-10 text-center text-fg-muted">
        Aucun jeu ne correspond à ces filtres.
      </div>

      <div v-else-if="tab === 'games'" class="space-y-2">
        <a
          v-for="g in filtered"
          :key="g.appid"
          :href="steamStoreUrl(g.appid)"
          target="_blank"
          rel="noopener"
          class="card flex items-center gap-4 p-2 transition hover:border-brand/40"
        >
          <div class="h-14 w-32 shrink-0 overflow-hidden rounded bg-app-surface2">
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
              <p class="truncate text-sm font-medium text-fg-strong">{{ g.name }}</p>
              <span v-if="g.playtime2Weeks > 0" class="badge bg-ok-soft text-ok">
                récent
              </span>
            </div>

            <div class="mt-1 flex flex-wrap gap-1">
              <span v-for="genre in g.genres.slice(0, 3)" :key="genre" class="badge bg-app-surface2 text-brand">
                {{ genre }}
              </span>
              <span v-if="!g.enriched" class="badge bg-app-surface2 text-fg-faint">genres ?</span>
            </div>

            <div class="mt-1.5 h-1 overflow-hidden rounded bg-app-surface2">
              <div
                class="h-full rounded bg-brand/70"
                :style="{ width: maxPlaytime ? (g.playtime / maxPlaytime) * 100 + '%' : '0%' }"
              ></div>
            </div>
          </div>

          <div class="shrink-0 text-right">
            <p class="text-sm font-semibold text-fg">{{ formatPlaytime(g.playtime) }}</p>
            <p v-if="g.playtime === 0" class="text-[10px] text-fg-faint">jamais lancé</p>
            <p v-else-if="g.playtime2Weeks > 0" class="text-[10px] text-ok/80">
              +{{ formatPlaytime(g.playtime2Weeks) }} ces 15 j
            </p>
          </div>
        </a>
      </div>

      <p v-if="tab === 'games' && filtered.length" class="mt-6 text-center text-xs text-fg-faint">
        {{ filtered.length }} jeu{{ filtered.length > 1 ? 'x' : '' }} affiché{{ filtered.length > 1 ? 's' : '' }}
        <template v-if="games.length !== filtered.length"> sur {{ games.length }}</template>
      </p>
    </template>
  </div>
</template>
