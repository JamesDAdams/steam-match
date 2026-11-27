<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { apiGet, formatPrice, hideBrokenImage, steamStoreUrl } from '../lib/api';

/**
 * Calendrier des sorties du groupe.
 *
 * Steam propose un « calendrier personnel », mais il exige une session Steam
 * (page personnalisée côté compte). Ici, on reconstitue l'équivalent à partir
 * des wishlists des membres et des dates de sortie du Store — et c'est celui
 * de tout le serveur, pas d'un seul joueur.
 */
interface Release {
  appid: number;
  name: string;
  headerImage: string | null;
  releaseDate: string;
  dateIso: string | null;
  daysUntil: number | null;
  wishCount: number;
  steamPrice: number | null;
  steamCurrency: string | null;
  steamDiscount: number | null;
  ownedBySomeone: boolean;
}

/** Jaquettes qui n'ont pas pu être chargées (l'URL du CDN peut manquer). */
const brokenImages = ref<Set<number>>(new Set());
function onImageError(appid: number) {
  brokenImages.value = new Set(brokenImages.value).add(appid);
}

const loading = ref(true);
const error = ref<string | null>(null);
/** 'all' = les wishlists de tout le serveur ; 'mine' = la mienne. */
const scope = ref<'all' | 'mine'>('all');
/** Faux quand on demande « mes sorties » sans compte Steam relié. */
const hasSteam = ref(true);
const upcoming = ref<Release[]>([]);
const recent = ref<Release[]>([]);
const later = ref<Release[]>([]);
const undated = ref<Release[]>([]);

function when(entry: Release): string {
  if (entry.daysUntil === null) return entry.releaseDate;
  if (entry.daysUntil === 0) return "aujourd'hui";
  if (entry.daysUntil === 1) return 'demain';
  if (entry.daysUntil > 1) {
    if (entry.daysUntil < 31) return `dans ${entry.daysUntil} jours`;
    const months = Math.round(entry.daysUntil / 30);
    return `dans ${months} mois`;
  }
  const ago = Math.abs(entry.daysUntil);
  return ago <= 1 ? 'hier' : `il y a ${ago} jours`;
}

async function load() {
  loading.value = true;
  error.value = null;
  try {
    const r = await apiGet<{
      upcoming: Release[];
      recent: Release[];
      later: Release[];
      undated: Release[];
      hasSteam?: boolean;
    }>('/api/releases', { scope: scope.value });
    upcoming.value = r.upcoming ?? [];
    recent.value = r.recent ?? [];
    later.value = r.later ?? [];
    undated.value = r.undated ?? [];
    hasSteam.value = r.hasSteam !== false;
  } catch (e: any) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

function setScope(next: 'all' | 'mine') {
  if (scope.value === next) return;
  scope.value = next;
  load();
}

onMounted(load);
</script>

<template>
  <div>
    <div class="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 class="font-display text-3xl font-bold text-fg-strong">Calendrier des sorties</h1>
        <p class="mt-1 max-w-2xl text-sm text-fg-muted">
          <template v-if="scope === 'mine'">
            Les jeux de <strong>ta</strong> wishlist Steam et leurs dates de sortie.
          </template>
          <template v-else>
            Les jeux que le groupe attend, d'après vos wishlists Steam — avec leurs
            dates de sortie. Ceux que quelqu'un possède déjà sont signalés.
          </template>
        </p>
      </div>

      <!-- Bascule : mes sorties / celles de tout le monde -->
      <div class="flex rounded border border-line p-0.5 text-sm" role="tablist">
        <button
          type="button"
          role="tab"
          :aria-selected="scope === 'mine'"
          class="rounded px-3 py-1.5 transition"
          :class="scope === 'mine' ? 'bg-brand-soft text-fg-strong' : 'text-fg-muted hover:text-fg'"
          @click="setScope('mine')"
        >
          Mes sorties
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="scope === 'all'"
          class="rounded px-3 py-1.5 transition"
          :class="scope === 'all' ? 'bg-brand-soft text-fg-strong' : 'text-fg-muted hover:text-fg'"
          @click="setScope('all')"
        >
          Tout le serveur
        </button>
      </div>
    </div>

    <div v-if="error" class="card mb-4 border-danger bg-danger-soft text-sm text-danger">
      {{ error }}
    </div>

    <div v-if="loading" class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <div v-for="i in 8" :key="i" class="h-40 animate-pulse rounded-lg bg-app-surface2"></div>
    </div>

    <template v-else>
      <template v-if="scope !== 'mine' || hasSteam">
      <!-- À venir -->
      <section class="mb-10">
        <div class="mb-3 flex items-center gap-2">
          <h2 class="font-display text-lg font-semibold text-fg-strong">Dans les 30 prochains jours</h2>
          <span class="badge bg-brand-soft text-brand">{{ upcoming.length }}</span>
        </div>

        <div v-if="upcoming.length" class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <a
            v-for="e in upcoming"
            :key="e.appid"
            :href="steamStoreUrl(e.appid)"
            target="_blank"
            rel="noopener"
            class="card group overflow-hidden p-0 transition hover:border-brand/50"
          >
            <div class="relative aspect-[460/215] w-full overflow-hidden bg-app-surface2">
              <img
                v-if="e.headerImage && !brokenImages.has(e.appid)"
                :src="e.headerImage"
                :alt="e.name"
                class="h-full w-full object-cover transition group-hover:scale-[1.02]"
                loading="lazy"
                @error="onImageError(e.appid)"
              />
              <div
                v-else
                class="flex h-full items-center justify-center bg-gradient-to-br from-app-surface2 to-app-bg text-3xl"
              >
                🎮
              </div>
              <span
                class="absolute left-2 top-2 rounded bg-black/70 px-2 py-0.5 text-[11px] font-medium text-white"
              >
                {{ when(e) }}
              </span>
              <span
                v-if="e.ownedBySomeone"
                class="absolute right-2 top-2 rounded bg-ok px-2 py-0.5 text-[10px] font-semibold text-white"
              >
                {{ scope === 'mine' ? 'déjà dans ma ludothèque' : 'déjà possédé' }}
              </span>
            </div>
            <div class="p-3">
              <p class="truncate text-sm font-semibold text-fg-strong">{{ e.name }}</p>
              <div class="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-fg-faint">
                <span>{{ e.releaseDate }}</span>
                <span v-if="e.wishCount > 1" class="badge bg-app-surface2 text-fg-muted">
                  {{ e.wishCount }} membres
                </span>
                <span v-if="e.steamPrice !== null" class="ml-auto text-fg-muted">
                  {{ formatPrice(e.steamPrice, e.steamCurrency ?? 'EUR') }}
                </span>
              </div>
            </div>
          </a>
        </div>
        <div v-else class="card py-8 text-center text-fg-muted">
          Aucune sortie prévue dans les 30 prochains jours.
        </div>
      </section>

      <!-- Sorties récentes -->
      <section v-if="recent.length" class="mb-10">
        <div class="mb-3 flex items-center gap-2">
          <h2 class="font-display text-lg font-semibold text-fg-strong">Sortis ces 3 derniers mois</h2>
          <span class="badge bg-app-surface2 text-fg-muted">{{ recent.length }}</span>
        </div>

        <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <a
            v-for="e in recent"
            :key="e.appid"
            :href="steamStoreUrl(e.appid)"
            target="_blank"
            rel="noopener"
            class="card group overflow-hidden p-0 transition hover:border-brand/50"
          >
            <div class="relative aspect-[460/215] w-full overflow-hidden bg-app-surface2">
              <img
                v-if="e.headerImage && !brokenImages.has(e.appid)"
                :src="e.headerImage"
                :alt="e.name"
                class="h-full w-full object-cover transition group-hover:scale-[1.02]"
                loading="lazy"
                @error="onImageError(e.appid)"
              />
              <div
                v-else
                class="flex h-full items-center justify-center bg-gradient-to-br from-app-surface2 to-app-bg text-3xl"
              >
                🎮
              </div>
              <span
                class="absolute left-2 top-2 rounded bg-black/70 px-2 py-0.5 text-[11px] font-medium text-white"
              >
                {{ when(e) }}
              </span>
            </div>
            <div class="p-3">
              <p class="truncate text-sm font-semibold text-fg-strong">{{ e.name }}</p>
              <div class="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-fg-faint">
                <span>{{ e.releaseDate }}</span>
                <span v-if="e.wishCount > 1" class="badge bg-app-surface2 text-fg-muted">
                  {{ e.wishCount }} membres
                </span>
              </div>
            </div>
          </a>
        </div>
      </section>

      <!-- Plus tard -->
      <section v-if="later.length" class="mb-10">
        <div class="mb-3 flex items-center gap-2">
          <h2 class="font-display text-lg font-semibold text-fg-strong">Plus tard</h2>
          <span class="badge bg-app-surface2 text-fg-muted">{{ later.length }}</span>
        </div>

        <ul class="card divide-y divide-line p-0">
          <li v-for="e in later" :key="e.appid" class="flex items-center gap-3 px-3 py-2">
            <img
              v-if="e.headerImage"
              :src="e.headerImage"
              alt=""
              class="h-8 w-16 shrink-0 rounded object-cover"
              loading="lazy"
              @error="hideBrokenImage"
            />
            <span class="min-w-0 flex-1 truncate text-sm text-fg">{{ e.name }}</span>
            <span class="shrink-0 text-[11px] text-fg-faint">{{ e.releaseDate }}</span>
            <a
              :href="steamStoreUrl(e.appid)"
              target="_blank"
              rel="noopener"
              class="shrink-0 text-xs text-brand hover:underline"
            >
              ↗
            </a>
          </li>
        </ul>
      </section>

      <!-- Sans date -->
      <section v-if="undated.length">
        <div class="mb-3 flex items-center gap-2">
          <h2 class="font-display text-lg font-semibold text-fg-strong">Annoncés, sans date</h2>
          <span class="badge bg-app-surface2 text-fg-muted">{{ undated.length }}</span>
        </div>

        <ul class="card divide-y divide-line p-0">
          <li
            v-for="e in undated"
            :key="e.appid"
            class="flex items-center gap-3 px-3 py-2"
          >
            <img
              v-if="e.headerImage"
              :src="e.headerImage"
              alt=""
              class="h-8 w-16 shrink-0 rounded object-cover"
              loading="lazy"
              @error="hideBrokenImage"
            />
            <span class="min-w-0 flex-1 truncate text-sm text-fg">{{ e.name }}</span>
            <span class="shrink-0 text-[11px] text-fg-faint">{{ e.releaseDate }}</span>
            <a
              :href="steamStoreUrl(e.appid)"
              target="_blank"
              rel="noopener"
              class="shrink-0 text-xs text-brand hover:underline"
            >
              ↗
            </a>
          </li>
        </ul>
      </section>

      </template>

      <div v-if="scope === 'mine' && !hasSteam" class="card py-12 text-center">
        <p class="text-lg font-semibold text-fg-strong">Aucun compte Steam relié</p>
        <p class="mx-auto mt-2 max-w-md text-sm text-fg-muted">
          Relie ton compte Steam depuis ton profil pour voir les sorties de ta
          propre wishlist.
        </p>
        <router-link to="/profil" class="btn-primary mt-4 text-sm">Mon profil</router-link>
      </div>

      <div
        v-else-if="!upcoming.length && !recent.length && !later.length && !undated.length"
        class="card py-12 text-center"
      >
        <p class="text-lg font-semibold text-fg-strong">Rien à afficher</p>
        <p class="mx-auto mt-2 max-w-md text-sm text-fg-muted">
          <template v-if="scope === 'mine'">
            Aucun jeu de ta wishlist n'a de date de sortie connue. Elle se
            remplit depuis ton profil.
          </template>
          <template v-else>
            Le calendrier se remplit avec les wishlists des membres. Synchronise
            la tienne depuis ton profil pour le compléter.
          </template>
        </p>
        <router-link to="/profil" class="btn-primary mt-4 text-sm">Mon profil</router-link>
      </div>
    </template>
  </div>
</template>
