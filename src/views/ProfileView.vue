<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import {
  apiGet,
  apiPost,
  apiDelete,
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
  /** 'owned' | 'secondary' | 'family' — origine du jeu. */
  source?: string;
  sourceSteamid?: string | null;
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
  /** Répartition par origine (compte principal, famille, secondaire). */
  ownedGames?: number;
  familyGames?: number;
  secondaryGames?: number;
  sharedGames?: number;
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

/* ── Comptes Steam liés (secondaire / famille) ──────────────────────── */

/**
 * Steam ne renvoie que les jeux achetés par le compte principal. Un joueur qui
 * possède un second compte, ou qui profite de la bibliothèque de sa famille
 * (Steam Families), déclare donc ces comptes ici : on aspire leur ludothèque
 * publique et chaque jeu garde son origine pour être étiqueté.
 */
interface LinkedAccount {
  steamid: string;
  kind: 'secondary' | 'family';
  personaName: string | null;
  avatarUrl: string | null;
  gamesCount: number;
  lastSyncedAt: string | null;
  lastError: string | null;
  profileUrl: string;
  /** Taille brute de la bibliothèque importée (avant déduplication). */
  importedCount?: number;
}

const accounts = ref<LinkedAccount[]>([]);
const maxAccounts = ref(5);
const accountValue = ref('');
const accountKind = ref<'family' | 'secondary'>('family');
const accountBusy = ref<string | null>(null); // 'new' ou steamid en cours
const accountError = ref<string | null>(null);
const accountMessage = ref<string | null>(null);

function accountKindLabel(kind: 'family' | 'secondary') {
  return kind === 'secondary' ? 'Compte secondaire' : 'Compte famille';
}

/**
 * Une seule liste pour le compte principal et les comptes liés : la page doit
 * les présenter de la même façon (avatar, nombre de jeux, dernière synchro),
 * ce qui n'était pas le cas du compte principal.
 */
const accountRows = computed(() => {
  const rows: {
    key: string;
    steamid: string;
    personaName: string | null;
    avatarUrl: string | null;
    kind: 'main' | 'secondary' | 'family';
    gamesCount: number;
    lastSyncedAt: string | null;
    lastError: string | null;
    profileUrl: string;
    isMain: boolean;
  }[] = [];

  if (me.value.steam) {
    rows.push({
      key: 'main',
      steamid: me.value.steam.steamid,
      personaName: me.value.steam.personaName,
      avatarUrl: me.value.steam.avatarUrl ?? null,
      kind: 'main',
      gamesCount: stats.value?.ownedGames ?? 0,
      lastSyncedAt: me.value.steam.lastSyncAt,
      lastError: null,
      profileUrl: `https://steamcommunity.com/profiles/${me.value.steam.steamid}`,
      isMain: true,
    });
  }

  for (const a of accounts.value) {
    rows.push({
      key: a.steamid,
      steamid: a.steamid,
      personaName: a.personaName,
      avatarUrl: a.avatarUrl,
      kind: a.kind,
      gamesCount: a.gamesCount,
      lastSyncedAt: a.lastSyncedAt,
      lastError: a.lastError,
      profileUrl: a.profileUrl,
      isMain: false,
    });
  }

  return rows;
});

function accountBadge(kind: 'main' | 'secondary' | 'family') {
  if (kind === 'main') return 'Compte principal';
  return accountKindLabel(kind);
}

function accountBadgeClass(kind: 'main' | 'secondary' | 'family') {
  if (kind === 'main') return 'bg-brand-soft text-brand';
  if (kind === 'secondary') return 'bg-app-surface2 text-fg-muted';
  return 'bg-ok-soft text-ok';
}

/* ── Chaîne Twitch ──────────────────────────────────────────────────── */

/**
 * Le lien Twitch vit dans sa propre table : une chaîne par membre, affichée
 * sur la page « Espace Twitch » avec le statut live.
 */
interface MyTwitch {
  login: string;
  displayName: string | null;
  avatarUrl: string | null;
  channelUrl: string;
  linkedAt?: string;
}

const twitch = ref<MyTwitch | null>(null);
const twitchInput = ref('');
const twitchBusy = ref(false);
const twitchError = ref<string | null>(null);
const twitchMessage = ref<string | null>(null);

async function loadTwitch() {
  try {
    const r = await apiGet<{ mine: MyTwitch | null }>('/api/twitch');
    twitch.value = r.mine ?? null;
  } catch {
    /* section secondaire */
  }
}

async function linkTwitch() {
  twitchError.value = null;
  twitchMessage.value = null;
  const value = twitchInput.value.trim();
  if (!value || twitchBusy.value) return;

  twitchBusy.value = true;
  try {
    const r = await apiPost<{ channel: MyTwitch & { login: string } }>('/api/twitch', { value });
    twitch.value = r.channel;
    twitchInput.value = '';
    twitchMessage.value = `Chaîne « ${r.channel.login} » reliée.`;
  } catch (e: any) {
    twitchError.value = e.message ?? 'Liaison impossible.';
  } finally {
    twitchBusy.value = false;
  }
}

async function unlinkTwitch() {
  twitchError.value = null;
  twitchMessage.value = null;
  twitchBusy.value = true;
  try {
    await apiDelete('/api/twitch');
    twitch.value = null;
    twitchMessage.value = 'Chaîne Twitch déliée.';
  } catch (e: any) {
    twitchError.value = e.message ?? 'Déliaison impossible.';
  } finally {
    twitchBusy.value = false;
  }
}

async function loadAccounts() {
  try {
    const r = await apiGet<{ accounts: LinkedAccount[]; maxAccounts: number }>(
      '/api/steam-accounts',
    );
    accounts.value = r.accounts ?? [];
    maxAccounts.value = r.maxAccounts ?? 5;
  } catch {
    /* pas bloquant : le reste du profil s'affiche */
  }
}

async function addAccount() {
  accountError.value = null;
  accountMessage.value = null;
  const value = accountValue.value.trim();
  if (!value || accountBusy.value) return;

  accountBusy.value = 'new';
  try {
    const r = await apiPost<{ account: LinkedAccount }>('/api/steam-accounts', {
      value,
      kind: accountKind.value,
    });
    accountValue.value = '';
    accountMessage.value =
      `« ${r.account.personaName ?? r.account.steamid} » ajouté — ` +
      `${r.account.gamesCount} jeu(x) importé(s).`;
    await Promise.all([loadAccounts(), load()]);
  } catch (e: any) {
    accountError.value = e.message ?? 'Ajout impossible.';
    await loadAccounts();
  } finally {
    accountBusy.value = null;
  }
}

async function resyncAccount(a: LinkedAccount) {
  accountError.value = null;
  accountMessage.value = null;
  accountBusy.value = a.steamid;
  try {
    const r = await apiPost<{ gamesCount: number }>('/api/steam-accounts', {
      steamid: a.steamid,
    });
    accountMessage.value = `${a.personaName ?? a.steamid} : ${r.gamesCount} jeu(x) importé(s).`;
    await Promise.all([loadAccounts(), load()]);
  } catch (e: any) {
    accountError.value = e.message ?? 'Synchronisation impossible.';
    await loadAccounts();
  } finally {
    accountBusy.value = null;
  }
}

async function removeAccount(a: LinkedAccount) {
  accountError.value = null;
  accountMessage.value = null;
  accountBusy.value = a.steamid;
  try {
    await apiDelete('/api/steam-accounts', { steamid: a.steamid });
    accounts.value = accounts.value.filter((x) => x.steamid !== a.steamid);
    accountMessage.value = `« ${a.personaName ?? a.steamid} » retiré.`;
    await load();
  } catch (e: any) {
    accountError.value = e.message ?? 'Retrait impossible.';
  } finally {
    accountBusy.value = null;
  }
}


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
const tab = ref<'games' | 'wishlist' | 'accounts' | 'twitch'>('games');

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

/**
 * Progression de l'enrichissement (genres, prix, dates) sur les jeux du membre.
 * Sert de barre de progression, comme sur la page « jeux en commun ».
 */
const enrichProgress = computed(() => {
  const total = stats.value?.totalGames ?? 0;
  const enriched = stats.value?.enrichedGames ?? 0;
  return {
    total,
    enriched,
    pending: Math.max(0, total - enriched),
    pct: total > 0 ? Math.round((enriched / total) * 100) : 0,
  };
});

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
/** Reflet réactif de l'état de la boucle (pollTimer n'est pas une ref). */
const pollingActive = ref(false);

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  pollingActive.value = false;
}

function startPolling() {
  if (pollTimer) return;
  pollingActive.value = true;
  pollTimer = setInterval(async () => {
    // Onglet inactif ou requête déjà en cours : on ne fait rien.
    if (document.hidden || refreshing.value) return;

    await load(true);

    // Plus rien à identifier NI à enrichir : la boucle a rempli son rôle.
    if (unidentifiedCount.value === 0 && enrichProgress.value.pending === 0) {
      stopPolling();
    }
  }, POLL_MS);
}

/** Y a-t-il encore des données à rafraîchir automatiquement ? */
const autoUpdating = computed(
  () =>
    pollingActive.value &&
    (unidentifiedCount.value > 0 || enrichProgress.value.pending > 0),
);

/**
 * ACCÉLÉRATION DE L'ENRICHISSEMENT
 * -------------------------------
 * Le cron traite la file en arrière-plan, mais son débit est plafonné par les
 * API externes (Steam, CheapShark). Quand un membre vient de synchroniser sa
 * ludothèque, on enchaîne donc des appels courts depuis le navigateur : ils
 * utilisent la même file, avec la même protection contre les doublons, et
 * multiplient le débit pendant la visite.
 *
 * La boucle s'arrête d'elle-même : plus rien en attente, onglet masqué, ou
 * plafond d'appels atteint (pour ne pas tourner indéfiniment).
 */
const PUMP_INTERVAL_MS = 400;
const PUMP_MAX_CALLS = 60;
let pumpTimer: ReturnType<typeof setTimeout> | null = null;
let pumpCalls = 0;

function stopPump() {
  if (pumpTimer) {
    clearTimeout(pumpTimer);
    pumpTimer = null;
  }
}

async function pumpEnrichment() {
  pumpTimer = null;

  if (pumpCalls >= PUMP_MAX_CALLS) return;

  // Onglet en arrière-plan : on ralentit au lieu de marteler le serveur.
  if (document.hidden) {
    pumpTimer = setTimeout(pumpEnrichment, 3000);
    return;
  }

  pumpCalls++;

  try {
    const r = await apiPost<{
      ok: boolean;
      metaDone: number;
      priceDone: number;
      metaPending: number;
      pricePending: number;
    }>('/api/enrich');

    const left = (r.metaPending ?? 0) + (r.pricePending ?? 0);

    // Rafraîchit l'affichage régulièrement, sans recharger à chaque appel.
    if (r.metaDone > 0 || r.priceDone > 0 || pumpCalls % 3 === 0) {
      await load(true);
    }

    if (left === 0) {
      stopPolling();
      return;
    }

    pumpTimer = setTimeout(pumpEnrichment, PUMP_INTERVAL_MS);
  } catch {
    // Erreur réseau ou 429 : on retente une fois, plus tard.
    if (pumpCalls < PUMP_MAX_CALLS) {
      pumpTimer = setTimeout(pumpEnrichment, 3000);
    }
  }
}

function startPump() {
  if (pumpTimer) return;
  pumpCalls = 0;
  pumpTimer = setTimeout(pumpEnrichment, 0);
}

onMounted(async () => {
  await Promise.all([load(), loadAccounts(), loadTwitch()]);
  if (unidentifiedCount.value > 0 || enrichProgress.value.pending > 0) {
    startPolling();
    if (unidentifiedCount.value > 0) startPump();
  }
});

onUnmounted(() => {
  stopPolling();
  stopPump();
});
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
          genres et prix se remplissent automatiquement —
          <template v-if="autoUpdating">
            accéléré tant que tu restes sur cette page.
          </template>
          <template v-else>
            tu peux revenir un peu plus tard.
          </template>
        </p>
      </div>

      <!-- Enrichissement des données du profil -->
      <div v-if="stats && enrichProgress.pending > 0" class="card mb-6">
        <div class="flex items-center justify-between gap-3 text-sm">
          <span class="text-fg">
            Enrichissement des genres — {{ enrichProgress.enriched }} /
            {{ enrichProgress.total }} jeux
          </span>
          <span class="text-brand">{{ enrichProgress.pct }} %</span>
        </div>
        <div class="mt-2 h-2 overflow-hidden rounded bg-app-surface2">
          <div
            class="stripes h-full rounded bg-brand/60 transition-all"
            :style="{ width: enrichProgress.pct + '%' }"
          ></div>
        </div>
        <p class="mt-2 text-xs text-fg-faint">
          Les métadonnées (noms, genres, prix) se remplissent automatiquement en
          arrière-plan. Cette page se met à jour toute seule
          <template v-if="autoUpdating"> — accéléré tant que tu restes ici.</template>.
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
          Pondéré par le temps de jeu réellement passé, pas par le nombre de jeux.
        </p>
        <!-- Deux colonnes : la version pleine largeur étirait chaque ligne sur
             toute la page pour deux informations seulement. -->
        <ol class="mt-4 grid gap-x-10 gap-y-1.5 sm:grid-cols-2">
          <li
            v-for="(g, i) in stats.topGenres"
            :key="g.name"
            class="flex items-baseline gap-3 text-sm"
          >
            <span class="w-5 shrink-0 text-right text-xs text-fg-faint">{{ i + 1 }}</span>
            <span class="min-w-0 flex-1 truncate text-fg">{{ g.name }}</span>
            <span class="shrink-0 text-xs text-fg-muted">{{ formatPlaytime(g.minutes) }}</span>
          </li>
        </ol>
      </section>

      <!-- Sélecteur : ludothèque / wishlist / comptes / twitch -->
      <section class="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
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
              <!-- Détail des jeux qui ne viennent pas du compte principal :
                   sans ça, le total semblait inclure des jeux « fantômes ». -->
              <p v-if="(stats?.sharedGames ?? 0) > 0" class="mt-1 text-[11px] text-fg-faint">
                <template v-if="(stats?.familyGames ?? 0) > 0">
                  {{ stats?.familyGames }} via la famille
                </template>
                <template v-if="(stats?.familyGames ?? 0) > 0 && (stats?.secondaryGames ?? 0) > 0">
                  ·
                </template>
                <template v-if="(stats?.secondaryGames ?? 0) > 0">
                  {{ stats?.secondaryGames }} via un compte secondaire
                </template>
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

        <button
          class="card-flat text-left transition hover:border-brand/50"
          :class="tab === 'accounts' ? '!border-brand ring-1 ring-brand/30' : ''"
          @click="tab = 'accounts'"
        >
          <div class="flex items-start justify-between gap-3">
            <div>
              <p class="text-xs uppercase tracking-wide text-fg-faint">Mes comptes Steam</p>
              <p class="mt-1 font-display text-2xl font-bold text-fg-strong">
                {{ accounts.length }}
              </p>
              <p class="mt-0.5 text-xs text-fg-muted">
                {{ accounts.length ? 'comptes secondaires ou famille' : 'secondaire ou famille' }}
              </p>
            </div>
            <span class="text-2xl">👪</span>
          </div>
        </button>

        <button
          class="card-flat text-left transition hover:border-brand/50"
          :class="tab === 'twitch' ? '!border-brand ring-1 ring-brand/30' : ''"
          @click="tab = 'twitch'"
        >
          <div class="flex items-start justify-between gap-3">
            <div>
              <p class="text-xs uppercase tracking-wide text-fg-faint">Twitch</p>
              <p class="mt-1 truncate font-display text-lg font-bold text-fg-strong">
                {{ twitch?.login ?? '—' }}
              </p>
              <p class="mt-0.5 text-xs text-fg-muted">
                {{ twitch ? 'chaîne reliée' : 'relier ma chaîne' }}
              </p>
            </div>
            <span class="text-2xl">🎥</span>
          </div>
        </button>
      </section>

      <!-- Comptes Steam liés -->
      <section v-if="tab === 'accounts'" class="card mb-6">
        <h2 class="font-semibold text-fg-strong">Mes comptes Steam</h2>
        <p class="mt-1 max-w-2xl text-sm text-fg-muted">
          Steam ne transmet que les jeux <strong class="text-fg">achetés par ton compte
          principal</strong>. Un second compte, ou la bibliothèque de ta famille (Steam
          Families), reste invisible : déclare-les ici pour les faire entrer dans ta
          ludothèque.
        </p>

        <!-- Compte principal + comptes liés : même présentation -->
        <ul class="mt-4 space-y-2">
          <li
            v-for="a in accountRows"
            :key="a.key"
            class="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-app-elevated p-3"
          >
            <img
              v-if="a.avatarUrl"
              :src="a.avatarUrl"
              alt=""
              class="h-10 w-10 shrink-0 rounded object-cover"
              loading="lazy"
            />
            <div
              v-else
              class="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-app-surface2 text-sm font-semibold text-fg-muted"
            >
              {{ (a.personaName ?? '?').charAt(0).toUpperCase() }}
            </div>

            <div class="min-w-0 flex-1">
              <p class="flex flex-wrap items-center gap-2 text-sm font-medium text-fg-strong">
                <span class="truncate">{{ a.personaName ?? a.steamid }}</span>
                <span class="badge" :class="accountBadgeClass(a.kind)">
                  {{ accountBadge(a.kind) }}
                </span>
              </p>
              <p class="text-[11px] text-fg-faint">
                {{ a.gamesCount }} jeu{{ a.gamesCount > 1 ? 'x' : '' }}
                <template v-if="!a.isMain && (a.importedCount ?? 0) > a.gamesCount">
                  (sur {{ a.importedCount }} importés)
                </template>
                <template v-if="a.isMain"> · synchronisé automatiquement</template>
                <template v-else-if="a.lastSyncedAt">
                  · synchronisé le {{ new Date(a.lastSyncedAt).toLocaleString('fr-FR') }}
                </template>
              </p>
              <p v-if="a.lastError" class="mt-1 text-[11px] text-danger">{{ a.lastError }}</p>
            </div>

            <div class="flex items-center gap-1">
              <a
                :href="a.profileUrl"
                target="_blank"
                rel="noopener"
                class="rounded px-2 py-1 text-xs text-brand transition hover:bg-brand-soft"
              >
                Profil Steam ↗
              </a>
              <button
                v-if="a.isMain"
                class="rounded px-2 py-1 text-xs text-fg-muted transition hover:bg-app-surface2 hover:text-fg-strong disabled:opacity-50"
                :disabled="syncing"
                @click="sync()"
              >
                {{ syncing ? '…' : 'Resynchroniser' }}
              </button>
              <template v-else>
                <button
                  class="rounded px-2 py-1 text-xs text-fg-muted transition hover:bg-app-surface2 hover:text-fg-strong disabled:opacity-50"
                  :disabled="accountBusy === a.steamid"
                  @click="resyncAccount(a)"
                >
                  {{ accountBusy === a.steamid ? '…' : 'Resynchroniser' }}
                </button>
                <button
                  class="rounded px-2 py-1 text-xs text-danger transition hover:bg-danger-soft disabled:opacity-50"
                  :disabled="accountBusy === a.steamid"
                  @click="removeAccount(a)"
                >
                  Retirer
                </button>
              </template>
            </div>
          </li>
        </ul>

        <p v-if="!accountRows.length" class="mt-4 text-sm text-fg-faint">
          Aucun compte Steam lié.
        </p>

        <p class="mt-3 text-[11px] text-fg-faint">
          Les compteurs ne sont pas ceux du client Steam : un jeu déjà présent dans
          un autre compte n'est pas compté deux fois, et Steam compte différemment
          les jeux gratuits, les outils et les démos.
        </p>


        <!-- Ajout -->
        <div class="mt-5 rounded-lg border border-dashed border-line-strong p-3">
          <p class="text-xs font-medium text-fg-muted">Ajouter un compte</p>

          <div class="mt-2 flex flex-wrap gap-2">
            <input
              v-model="accountValue"
              type="text"
              class="input min-w-[240px] flex-1"
              placeholder="Lien de profil Steam ou identifiant d’URL personnalisée"
              @keydown.enter.prevent="addAccount"
            />
            <button
              class="btn-primary text-sm"
              :disabled="!!accountBusy || !accountValue.trim() || accounts.length >= maxAccounts"
              @click="addAccount"
            >
              {{ accountBusy === 'new' ? 'Import…' : 'Ajouter' }}
            </button>
          </div>

          <!-- Type de compte : le point clé de la demande -->
          <div class="mt-3 grid gap-2 sm:grid-cols-2">
            <button
              type="button"
              class="rounded-lg border px-3 py-2 text-left text-sm transition"
              :class="
                accountKind === 'family'
                  ? 'border-brand bg-brand-soft text-fg-strong'
                  : 'border-line bg-app-elevated text-fg-muted hover:border-line-strong'
              "
              @click="accountKind = 'family'"
            >
              <span class="block font-medium">Compte famille</span>
              <span class="text-[11px] text-fg-faint">
                Bibliothèque d’un proche (Steam Families)
              </span>
            </button>
            <button
              type="button"
              class="rounded-lg border px-3 py-2 text-left text-sm transition"
              :class="
                accountKind === 'secondary'
                  ? 'border-brand bg-brand-soft text-fg-strong'
                  : 'border-line bg-app-elevated text-fg-muted hover:border-line-strong'
              "
              @click="accountKind = 'secondary'"
            >
              <span class="block font-medium">Compte secondaire</span>
              <span class="text-[11px] text-fg-faint">Ton deuxième compte Steam</span>
            </button>
          </div>

          <p class="mt-2 text-[11px] text-fg-faint">
            Le profil Steam doit être <strong class="text-fg-muted">public</strong> et la
            liste de jeux visible. {{ accounts.length }}/{{ maxAccounts }} comptes liés.
          </p>
        </div>

        <p v-if="accountError" class="mt-3 text-xs text-danger">{{ accountError }}</p>
        <p v-else-if="accountMessage" class="mt-3 text-xs text-ok">{{ accountMessage }}</p>
      </section>

      <!-- Chaîne Twitch -->
      <section v-if="tab === 'twitch'" class="card mb-6">
        <h2 class="font-semibold text-fg-strong">Ma chaîne Twitch</h2>
        <p class="mt-1 max-w-2xl text-sm text-fg-muted">
          Relie ta chaîne pour apparaître sur la page
          <router-link to="/twitch" class="text-brand hover:underline">Espace Twitch</router-link>,
          avec ton statut « en direct » mis à jour automatiquement.
        </p>

        <div
          v-if="twitch"
          class="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-line bg-app-elevated p-3"
        >
          <img
            v-if="twitch.avatarUrl"
            :src="twitch.avatarUrl"
            alt=""
            class="h-10 w-10 shrink-0 rounded-full object-cover"
            loading="lazy"
          />
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-medium text-fg-strong">
              {{ twitch.displayName ?? twitch.login }}
            </p>
            <p class="text-[11px] text-fg-faint">twitch.tv/{{ twitch.login }}</p>
          </div>
          <a
            :href="twitch.channelUrl"
            target="_blank"
            rel="noopener"
            class="rounded px-2 py-1 text-xs text-brand transition hover:bg-brand-soft"
          >
            Voir la chaîne ↗
          </a>
          <button
            class="rounded px-2 py-1 text-xs text-danger transition hover:bg-danger-soft disabled:opacity-50"
            :disabled="twitchBusy"
            @click="unlinkTwitch"
          >
            Délier
          </button>
        </div>

        <div v-else class="mt-4 flex flex-wrap gap-2">
          <input
            v-model="twitchInput"
            type="text"
            class="input min-w-[240px] flex-1"
            placeholder="https://www.twitch.tv/tonpseudo"
            @keydown.enter.prevent="linkTwitch"
          />
          <button
            class="btn-primary text-sm"
            :disabled="twitchBusy || !twitchInput.trim()"
            @click="linkTwitch"
          >
            {{ twitchBusy ? 'Vérification…' : 'Relier' }}
          </button>
        </div>

        <p v-if="twitchError" class="mt-2 text-xs text-danger">{{ twitchError }}</p>
        <p v-else-if="twitchMessage" class="mt-2 text-xs text-ok">{{ twitchMessage }}</p>
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
                title="Provient de ton compte Steam secondaire"
              >
                Compte secondaire
              </span>
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
