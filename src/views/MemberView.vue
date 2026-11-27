<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import {
  apiGet,
  formatPlaytime,
  formatPrice,
  hideBrokenImage,
  steamHeaderUrl,
  steamStoreUrl,
} from '../lib/api';
import { mergeLibraries, type ExternalLibGame } from '../lib/library';

/**
 * Fiche d'un membre : sa ludothèque, ses genres et son temps de jeu.
 *
 * La page est PUBLIQUE, mais ce qu'elle montre dépend de la personne :
 *   • `profilePublic` (défaut false) → un visiteur non connecté peut voir la
 *     ludothèque ; sinon la fiche reste fermée ;
 *   • `gamesPublic` (défaut false) → les durées (par jeu et au total) sont
 *     affichées ; sinon elles sont masquées (« — »).
 *
 * Le pseudo Steam n'est jamais transmis à un visiteur non connecté.
 * La présentation des jeux est celle du profil personnel : mêmes badges,
 * même barre de temps de jeu, même fusion Steam / GOG / Epic.
 */
interface LibGame {
  appid: number | null;
  name: string;
  headerImage: string | null;
  genres: string[];
  source?: string;
  enriched: boolean;
  playtime: number;
  playtime2Weeks: number;
  cheapestPrice: number | null;
  cheapestCurrency: string | null;
  steamPrice: number | null;
  steamCurrency: string | null;
  reviewScore: number | null;
  platforms?: string[];
  external?: { platform: string; accountName: string | null; minutes: number }[];
}

interface Wish {
  appid: number;
  name: string;
  headerImage: string | null;
  genres: string[];
  playableNow: boolean;
  owners: string[];
  steamPrice: number | null;
  steamCurrency: string | null;
  cheapestPrice: number | null;
  cheapestCurrency: string | null;
  cheapestStore: string | null;
  releaseDate: string | null;
}

interface Member {
  discordId: string;
  name: string;
  avatarUrl: string | null;
  isAdmin: boolean;
  joinedAt: string | null;
  hasAccount: boolean;
  hasSteam: boolean;
  gamesPublic: boolean;
  profilePublic: boolean;
}

const route = useRoute();
const discordId = computed(() => String(route.params.discordId ?? ''));

const loading = ref(true);
const error = ref<string | null>(null);
const member = ref<Member | null>(null);
const steam = ref<{
  steamid: string;
  personaName: string;
  avatarUrl: string | null;
  profileUrl: string | null;
} | null>(null);
const stats = ref<{
  totalGames: number;
  playedGames: number;
  totalMinutes: number;
  family: number;
  secondary: number;
} | null>(null);
const topGenres = ref<{ name: string; minutes: number }[]>([]);
const games = ref<LibGame[]>([]);
const externalGames = ref<ExternalLibGame[]>([]);
const wishlist = ref<Wish[]>([]);
const isMe = ref(false);
const isPrivate = ref(false);
const showMinutes = ref(true);
const wishlistVisible = ref(false);
const tab = ref<'games' | 'wishlist'>('games');

const search = ref('');
const sortBy = ref<'playtime' | 'name'>('playtime');

/** Steam + GOG + Epic, fusionnés par titre (même logique que son profil). */
const library = computed(() =>
  mergeLibraries<LibGame>(games.value, externalGames.value, (ext) => ({
    appid: null,
    name: ext.name,
    headerImage: ext.imageUrl,
    genres: [],
    source: ext.platform,
    enriched: false,
    playtime: ext.minutes,
    playtime2Weeks: 0,
    cheapestPrice: null,
    cheapestCurrency: null,
    steamPrice: null,
    steamCurrency: null,
    reviewScore: null,
    platforms: [ext.platform],
    external: [
      { platform: ext.platform, accountName: ext.displayName ?? null, minutes: ext.minutes },
    ],
  })),
);

/** Échelle des barres de temps de jeu. */
const maxPlaytime = computed(() =>
  library.value.reduce((m, g) => Math.max(m, g.playtime), 0),
);

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  const list = q
    ? library.value.filter((g) => g.name.toLowerCase().includes(q))
    : [...library.value];
  list.sort((a, b) =>
    sortBy.value === 'name' ? a.name.localeCompare(b.name, 'fr') : b.playtime - a.playtime,
  );
  return list;
});

const filteredWishlist = computed(() => {
  const q = search.value.trim().toLowerCase();
  const list = q
    ? wishlist.value.filter((w) => w.name.toLowerCase().includes(q))
    : [...wishlist.value];
  // Ce que quelqu'un d'autre possède déjà d'abord : c'est jouable ce soir.
  list.sort(
    (a, b) => Number(b.playableNow) - Number(a.playableNow) || a.name.localeCompare(b.name, 'fr'),
  );
  return list;
});

async function load() {
  loading.value = true;
  error.value = null;
  try {
    const r = await apiGet<{
      member: Member;
      steam: typeof steam.value;
      stats: typeof stats.value;
      topGenres: { name: string; minutes: number }[];
      games: LibGame[];
      externalGames: ExternalLibGame[];
      wishlist: Wish[];
      isMe: boolean;
      private?: boolean;
      showMinutes?: boolean;
      wishlistVisible?: boolean;
    }>('/api/members', { discordId: discordId.value });

    member.value = r.member;
    steam.value = r.steam;
    stats.value = r.stats;
    topGenres.value = r.topGenres ?? [];
    games.value = r.games ?? [];
    externalGames.value = r.externalGames ?? [];
    wishlist.value = r.wishlist ?? [];
    isMe.value = Boolean(r.isMe);
    isPrivate.value = Boolean(r.private);
    showMinutes.value = r.showMinutes !== false;
    wishlistVisible.value = Boolean(r.wishlistVisible);
    tab.value = 'games';
  } catch (e: any) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

onMounted(load);
watch(discordId, load);
</script>

<template>
  <div>
    <router-link to="/membres" class="mb-4 inline-block text-sm text-brand hover:underline">
      ← Tous les membres
    </router-link>

    <div v-if="error" class="card border-danger bg-danger-soft text-sm text-danger">
      {{ error }}
    </div>

    <div v-else-if="loading" class="space-y-4">
      <div class="h-24 animate-pulse rounded-lg bg-app-surface2"></div>
      <div class="h-40 animate-pulse rounded-lg bg-app-surface2"></div>
    </div>

    <template v-else-if="member">
      <!-- Identité -->
      <section class="card mb-6 flex flex-wrap items-center gap-4">
        <img
          v-if="member.avatarUrl"
          :src="member.avatarUrl"
          :alt="member.name"
          class="h-16 w-16 rounded-full object-cover"
        />
        <div
          v-else
          class="flex h-16 w-16 items-center justify-center rounded-full bg-app-surface2 text-lg font-semibold text-fg-muted"
        >
          {{ member.name.charAt(0).toUpperCase() }}
        </div>

        <div class="min-w-0 flex-1">
          <h1 class="flex flex-wrap items-center gap-2 font-display text-2xl font-bold text-fg-strong">
            <span class="truncate">{{ member.name }}</span>
            <span v-if="member.isAdmin" class="badge bg-gold-soft text-gold">admin</span>
            <span v-if="isMe" class="badge bg-brand-soft text-brand">toi</span>
            <span
              v-if="!member.profilePublic"
              class="badge bg-app-surface2 text-fg-muted"
              title="Seuls les membres connectés au site voient cette fiche."
            >
              fiche privée
            </span>
          </h1>
          <p class="mt-1 text-sm text-fg-muted">
            <template v-if="member.hasSteam">Compte Steam relié</template>
            <template v-else>Compte Steam non relié</template>
            <template v-if="member.joinedAt">
              · sur le serveur depuis le
              {{ new Date(member.joinedAt).toLocaleDateString('fr-FR') }}
            </template>
          </p>
        </div>

        <div class="flex items-center gap-2">
          <!-- Pas de lien Steam pour un visiteur : la page Steam affiche le
               pseudo du compte, justement ce qu'on masque. -->
          <a
            v-if="steam?.steamid"
            :href="steam.profileUrl ?? `https://steamcommunity.com/profiles/${steam.steamid}`"
            target="_blank"
            rel="noopener"
            class="btn-ghost text-sm"
          >
            Profil Steam ↗
          </a>
          <router-link v-if="!isMe && wishlistVisible" to="/commun" class="btn-ghost text-sm">
            Jeux en commun
          </router-link>
        </div>
      </section>

      <!-- Fiche fermée aux visiteurs -->
      <div v-if="isPrivate" class="card py-10 text-center">
        <p class="text-lg font-semibold text-fg-strong">Profil privé</p>
        <p class="mx-auto mt-2 max-w-md text-sm text-fg-muted">
          Ce membre n'a pas ouvert sa fiche aux visiteurs. Ses jeux et son temps de jeu ne
          s'affichent que pour les membres connectés du site.
        </p>
        <a href="/api/auth/discord" class="btn btn-primary mt-4 text-sm">Se connecter</a>
      </div>

      <!-- Pas de ludothèque -->
      <div v-else-if="!library.length && !stats" class="card py-10 text-center">
        <p class="text-lg font-semibold text-fg-strong">Pas encore de ludothèque</p>
        <p class="mx-auto mt-2 max-w-md text-sm text-fg-muted">
          Ce membre n'a pas relié de compte Steam, GOG ou Epic. Ses jeux apparaîtront ici dès
          qu'il l'aura fait depuis son profil.
        </p>
      </div>

      <template v-else>
        <!-- Statistiques (masquées si le membre ne publie pas ses chiffres) -->
        <p
          v-if="!showMinutes"
          class="mb-4 rounded-lg border border-line bg-app-surface px-3 py-2 text-xs text-fg-muted"
        >
          Ce membre n'a pas rendu publics son nombre de jeux et son temps de jeu.
        </p>
        <section v-else-if="stats" class="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div class="card">
            <p class="text-xs uppercase tracking-wide text-fg-faint">Jeux</p>
            <p class="mt-1 text-2xl font-bold text-fg-strong">{{ library.length }}</p>
            <p class="text-xs text-fg-faint">{{ stats.playedGames }} lancés</p>
          </div>
          <div class="card">
            <p class="text-xs uppercase tracking-wide text-fg-faint">Temps de jeu</p>
            <p class="mt-1 text-2xl font-bold text-brand">
              {{ formatPlaytime(stats.totalMinutes) }}
            </p>
            <p class="text-xs text-fg-faint">toutes plateformes confondues</p>
          </div>
          <div class="card">
            <p class="text-xs uppercase tracking-wide text-fg-faint">Via la famille</p>
            <p class="mt-1 text-2xl font-bold text-fg-strong">{{ stats.family }}</p>
            <p class="text-xs text-fg-faint">jeux partagés</p>
          </div>
          <div class="card">
            <p class="text-xs uppercase tracking-wide text-fg-faint">Compte secondaire</p>
            <p class="mt-1 text-2xl font-bold text-fg-strong">{{ stats.secondary }}</p>
            <p class="text-xs text-fg-faint">jeux importés</p>
          </div>
        </section>

        <!-- Styles de jeu -->
        <section v-if="topGenres.length" class="card mb-6">
          <h2 class="font-semibold text-fg-strong">Ses styles de jeu</h2>
          <ol class="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-3 lg:grid-cols-4">
            <li
              v-for="(g, i) in topGenres"
              :key="g.name"
              class="flex items-baseline gap-2 text-xs"
            >
              <span class="w-3 shrink-0 text-right text-[10px] text-fg-faint">{{ i + 1 }}</span>
              <span class="min-w-0 flex-1 truncate text-fg">{{ g.name }}</span>
              <span class="shrink-0 text-[11px] text-fg-muted">{{ formatPlaytime(g.minutes) }}</span>
            </li>
          </ol>
        </section>

        <!-- Onglets + recherche -->
        <section class="card mb-6">
          <div class="flex flex-wrap items-center gap-3">
            <div class="flex rounded border border-line p-0.5 text-sm">
              <button
                class="rounded px-3 py-1 transition"
                :class="tab === 'games' ? 'bg-brand-soft text-fg-strong' : 'text-fg-muted'"
                @click="tab = 'games'"
              >
                Ludothèque
                <span class="ml-1 text-[11px] opacity-70">{{ library.length }}</span>
              </button>
              <button
                v-if="wishlistVisible"
                class="rounded px-3 py-1 transition"
                :class="tab === 'wishlist' ? 'bg-brand-soft text-fg-strong' : 'text-fg-muted'"
                @click="tab = 'wishlist'"
              >
                Wishlist
                <span class="ml-1 text-[11px] opacity-70">{{ wishlist.length }}</span>
              </button>
            </div>
            <div class="ml-auto flex flex-wrap items-center gap-2">
              <input
                v-model="search"
                type="text"
                class="input w-56 !py-1.5 text-sm"
                placeholder="Rechercher un jeu…"
              />
              <select
                v-model="sortBy"
                class="rounded border border-line bg-app-bg px-3 py-1.5 text-sm text-fg"
              >
                <option value="playtime">Temps de jeu</option>
                <option value="name">Nom (A→Z)</option>
              </select>
            </div>
          </div>
        </section>

        <!-- Ludothèque : mêmes cartes que sur son propre profil -->
        <div v-if="tab === 'games' && filtered.length" class="space-y-2">
          <component
            :is="g.appid ? 'a' : 'div'"
            v-for="g in filtered.slice(0, 300)"
            :key="g.appid ?? g.name"
            :href="g.appid ? steamStoreUrl(g.appid) : undefined"
            :target="g.appid ? '_blank' : undefined"
            :rel="g.appid ? 'noopener' : undefined"
            class="card flex items-center gap-4 p-2 transition hover:border-brand/40"
          >
            <div class="h-14 w-32 shrink-0 overflow-hidden rounded bg-app-surface2">
              <img
                :src="g.headerImage || (g.appid ? steamHeaderUrl(g.appid) : '')"
                :alt="g.name"
                loading="lazy"
                class="h-full w-full object-cover"
                @error="hideBrokenImage"
              />
            </div>

            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-baseline gap-2">
                <p class="truncate text-sm font-medium text-fg-strong">{{ g.name }}</p>
                <span
                  v-if="g.source === 'family'"
                  class="badge bg-ok-soft text-ok"
                  title="Provient de la bibliothèque d’un compte famille (Steam Families)"
                >
                  Famille
                </span>
                <span
                  v-else-if="g.source === 'secondary'"
                  class="badge bg-app-surface2 text-fg-muted"
                  title="Provient d’un compte Steam secondaire"
                >
                  Compte secondaire
                </span>
                <span v-if="showMinutes && g.playtime2Weeks > 0" class="badge bg-ok-soft text-ok">
                  récent
                </span>
                <span
                  v-if="g.platforms?.includes('gog')"
                  class="badge bg-app-surface2 text-fg-muted"
                  title="Également possédé sur GOG"
                >
                  GOG
                </span>
                <span
                  v-if="g.platforms?.includes('epic')"
                  class="badge bg-app-surface2 text-fg-muted"
                  title="Également possédé sur Epic"
                >
                  Epic
                </span>
              </div>

              <div class="mt-1 flex flex-wrap gap-1">
                <span
                  v-for="genre in g.genres.slice(0, 3)"
                  :key="genre"
                  class="badge bg-app-surface2 text-brand"
                >
                  {{ genre }}
                </span>
                <span v-if="g.appid && !g.enriched" class="badge bg-app-surface2 text-fg-faint">
                  genres ?
                </span>
              </div>

              <div v-if="showMinutes" class="mt-1.5 h-1 overflow-hidden rounded bg-app-surface2">
                <div
                  class="h-full rounded bg-brand/70"
                  :style="{ width: maxPlaytime ? (g.playtime / maxPlaytime) * 100 + '%' : '0%' }"
                ></div>
              </div>
            </div>

            <div v-if="showMinutes" class="shrink-0 text-right">
              <p class="text-sm font-semibold text-fg">
                {{ g.playtime > 0 ? formatPlaytime(g.playtime) : '—' }}
              </p>
              <p v-if="g.playtime === 0" class="text-[10px] text-fg-faint">
                {{ g.appid ? 'jamais lancé' : 'pas d’heures' }}
              </p>
              <p v-else-if="g.playtime2Weeks > 0" class="text-[10px] text-ok/80">
                +{{ formatPlaytime(g.playtime2Weeks) }} ces 15 j
              </p>
            </div>
          </component>
          <p v-if="filtered.length > 300" class="pt-2 text-center text-xs text-fg-faint">
            {{ filtered.length - 300 }} autres jeux — affine la recherche pour les voir.
          </p>
        </div>

        <div v-else-if="tab === 'games'" class="card py-8 text-center text-fg-muted">
          Aucun jeu ne correspond à cette recherche.
        </div>

        <!-- Wishlist (membres connectés uniquement) -->
        <div v-if="tab === 'wishlist' && wishlistVisible">
          <div v-if="filteredWishlist.length" class="space-y-2">
            <a
              v-for="w in filteredWishlist.slice(0, 300)"
              :key="w.appid"
              :href="steamStoreUrl(w.appid)"
              target="_blank"
              rel="noopener"
              class="card flex items-center gap-4 p-2 transition hover:border-brand/40"
            >
              <div class="h-12 w-28 shrink-0 overflow-hidden rounded bg-app-surface2">
                <img
                  :src="w.headerImage || steamHeaderUrl(w.appid)"
                  :alt="w.name"
                  loading="lazy"
                  class="h-full w-full object-cover"
                  @error="hideBrokenImage"
                />
              </div>
              <div class="min-w-0 flex-1">
                <p class="flex flex-wrap items-baseline gap-2">
                  <span class="truncate text-sm font-medium text-fg-strong">{{ w.name }}</span>
                  <span v-if="w.playableNow" class="badge bg-ok-soft text-ok">déjà possédé</span>
                </p>
                <p class="truncate text-[11px] text-fg-faint">
                  <template v-if="w.owners.length">
                    Possédé par {{ w.owners.slice(0, 3).join(', ') }}
                    <template v-if="w.owners.length > 3">
                      et {{ w.owners.length - 3 }} autre(s)
                    </template>
                  </template>
                  <template v-else>Personne du groupe ne l'a encore</template>
                </p>
              </div>
              <span class="shrink-0 text-right text-xs text-fg-muted">
                <template v-if="w.cheapestPrice !== null">
                  clé {{ formatPrice(w.cheapestPrice, w.cheapestCurrency ?? 'EUR') }}
                </template>
                <template v-else-if="w.steamPrice !== null">
                  Steam {{ formatPrice(w.steamPrice, w.steamCurrency ?? 'EUR') }}
                </template>
              </span>
            </a>
            <p v-if="filteredWishlist.length > 300" class="pt-2 text-center text-xs text-fg-faint">
              {{ filteredWishlist.length - 300 }} autres jeux — affine la recherche.
            </p>
          </div>
          <div v-else class="card py-8 text-center text-fg-muted">
            Aucun jeu ne correspond à cette recherche.
          </div>
        </div>
      </template>
    </template>
  </div>
</template>
