<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { apiGet, formatPlaytime, hideBrokenImage, steamHeaderUrl, steamStoreUrl } from '../lib/api';

/**
 * Profil public d'un membre : sa ludothèque Steam, ses genres et son temps de
 * jeu. Lecture seule — c'est la fiche que les autres voient.
 */
interface Game {
  appid: number;
  name: string;
  headerImage: string | null;
  genres: string[];
  source: string;
  playtime: number;
  steamPrice: number | null;
  steamCurrency: string | null;
}

interface Member {
  discordId: string;
  name: string;
  avatarUrl: string | null;
  isAdmin: boolean;
  lastLoginAt: string | null;
  joinedAt: string | null;
  hasAccount: boolean;
}

const route = useRoute();
const discordId = computed(() => String(route.params.discordId ?? ''));

const loading = ref(true);
const error = ref<string | null>(null);
const member = ref<Member | null>(null);
const steam = ref<{ steamid: string; personaName: string; avatarUrl: string | null; profileUrl: string | null } | null>(null);
const stats = ref<{ totalGames: number; playedGames: number; totalMinutes: number; family: number; secondary: number } | null>(null);
const topGenres = ref<{ name: string; minutes: number }[]>([]);
const games = ref<Game[]>([]);
const isMe = ref(false);

const search = ref('');
const sortBy = ref<'playtime' | 'name'>('playtime');

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  let list = q ? games.value.filter((g) => g.name.toLowerCase().includes(q)) : [...games.value];
  list.sort((a, b) =>
    sortBy.value === 'name' ? a.name.localeCompare(b.name, 'fr') : b.playtime - a.playtime,
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
      games: Game[];
      isMe: boolean;
    }>('/api/members', { discordId: discordId.value });

    member.value = r.member;
    steam.value = r.steam;
    stats.value = r.stats;
    topGenres.value = r.topGenres ?? [];
    games.value = r.games ?? [];
    isMe.value = r.isMe;
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
          </h1>
          <p class="mt-1 text-sm text-fg-muted">
            <template v-if="steam">Steam : {{ steam.personaName }}</template>
            <template v-else>Compte Steam non relié</template>
            <template v-if="member.joinedAt">
              · sur le serveur depuis le {{ new Date(member.joinedAt).toLocaleDateString('fr-FR') }}
            </template>
          </p>
        </div>

        <div class="flex items-center gap-2">
          <a
            v-if="steam"
            :href="steam.profileUrl ?? `https://steamcommunity.com/profiles/${steam.steamid}`"
            target="_blank"
            rel="noopener"
            class="btn-ghost text-sm"
          >
            Profil Steam ↗
          </a>
          <router-link v-if="!isMe" to="/commun" class="btn-ghost text-sm">
            Jeux en commun
          </router-link>
        </div>
      </section>

      <!-- Pas de ludothèque -->
      <div v-if="!steam" class="card py-10 text-center">
        <p class="text-lg font-semibold text-fg-strong">Pas encore de ludothèque</p>
        <p class="mx-auto mt-2 max-w-md text-sm text-fg-muted">
          Ce membre n'a pas relié son compte Steam. Ses jeux apparaîtront ici dès
          qu'il l'aura fait depuis son profil.
        </p>
      </div>

      <template v-else>
        <!-- Statistiques -->
        <section class="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div class="card">
            <p class="text-xs uppercase tracking-wide text-fg-faint">Jeux</p>
            <p class="mt-1 text-2xl font-bold text-fg-strong">{{ stats?.totalGames ?? 0 }}</p>
            <p class="text-xs text-fg-faint">{{ stats?.playedGames ?? 0 }} lancés</p>
          </div>
          <div class="card">
            <p class="text-xs uppercase tracking-wide text-fg-faint">Temps de jeu</p>
            <p class="mt-1 text-2xl font-bold text-brand">
              {{ formatPlaytime(stats?.totalMinutes ?? 0) }}
            </p>
            <p class="text-xs text-fg-faint">toutes plateformes confondues</p>
          </div>
          <div class="card">
            <p class="text-xs uppercase tracking-wide text-fg-faint">Via la famille</p>
            <p class="mt-1 text-2xl font-bold text-fg-strong">{{ stats?.family ?? 0 }}</p>
            <p class="text-xs text-fg-faint">jeux partagés</p>
          </div>
          <div class="card">
            <p class="text-xs uppercase tracking-wide text-fg-faint">Compte secondaire</p>
            <p class="mt-1 text-2xl font-bold text-fg-strong">{{ stats?.secondary ?? 0 }}</p>
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

        <!-- Ludothèque -->
        <section class="card mb-6">
          <div class="flex flex-wrap items-center gap-3">
            <h2 class="font-semibold text-fg-strong">Sa ludothèque</h2>
            <span class="text-xs text-fg-faint">{{ games.length }} jeux</span>
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

        <div v-if="filtered.length" class="space-y-2">
          <a
            v-for="g in filtered.slice(0, 300)"
            :key="g.appid"
            :href="steamStoreUrl(g.appid)"
            target="_blank"
            rel="noopener"
            class="card flex items-center gap-4 p-2 transition hover:border-brand/40"
          >
            <div class="h-12 w-28 shrink-0 overflow-hidden rounded bg-app-surface2">
              <img
                :src="g.headerImage || steamHeaderUrl(g.appid)"
                :alt="g.name"
                loading="lazy"
                class="h-full w-full object-cover"
                @error="hideBrokenImage"
              />
            </div>
            <div class="min-w-0 flex-1">
              <p class="flex flex-wrap items-baseline gap-2">
                <span class="truncate text-sm font-medium text-fg-strong">{{ g.name }}</span>
                <span v-if="g.source === 'family'" class="badge bg-ok-soft text-ok">Famille</span>
                <span v-else-if="g.source === 'secondary'" class="badge bg-app-surface2 text-fg-muted">
                  Compte secondaire
                </span>
              </p>
              <p class="truncate text-[11px] text-fg-faint">
                {{ (g.genres ?? []).slice(0, 3).join(' · ') || 'genres inconnus' }}
              </p>
            </div>
            <span class="shrink-0 text-xs text-fg-muted">
              {{ g.playtime > 0 ? formatPlaytime(g.playtime) : 'jamais lancé' }}
            </span>
          </a>
          <p v-if="filtered.length > 300" class="pt-2 text-center text-xs text-fg-faint">
            {{ filtered.length - 300 }} autres jeux — affine la recherche pour les voir.
          </p>
        </div>

        <div v-else class="card py-8 text-center text-fg-muted">
          Aucun jeu ne correspond à cette recherche.
        </div>
      </template>
    </template>
  </div>
</template>
