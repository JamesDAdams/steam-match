<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { apiGet } from '../lib/api';

/**
 * Récap' du groupe.
 *
 * La page affiche l'image déjà générée par la tâche planifiée (une par jour) et
 * la liste détaillée. L'image est un SVG : les jaquettes y sont embarquées en
 * base64, donc le fichier est autonome — on peut le télécharger, le poster sur
 * Discord ou l'utiliser en aperçu, sans dépendre du CDN Steam.
 */
interface Player {
  name: string;
  minutes: number;
}

interface RecapGame {
  appid: number;
  name: string;
  headerImage: string | null;
  minutes: number;
  lastPlayedAt: string | null;
  players: Player[];
}

interface RecapStats {
  days: number;
  mode: 'measured' | 'estimated';
  windowStart: string;
  windowEnd: string;
  coverageDays: number;
  historyStart: string | null;
  generatedAt: string;
  top: RecapGame[];
  launched: RecapGame[];
  totals: { minutes: number; games: number; players: number };
}

const loading = ref(true);
const error = ref<string | null>(null);
const enabled = ref(true);
const stats = ref<RecapStats | null>(null);
const generatedAt = ref<string | null>(null);
const imageVersion = ref<string>('');
const downloading = ref(false);
const downloadError = ref<string | null>(null);

async function load() {
  loading.value = true;
  try {
    const r = await apiGet<{
      enabled: boolean;
      stats: RecapStats | null;
      image: { generatedAt: string } | null;
    }>('/api/recap');
    enabled.value = r.enabled;
    stats.value = r.stats;
    generatedAt.value = r.image?.generatedAt ?? null;
    imageVersion.value = r.image ? String(new Date(r.image.generatedAt).getTime()) : '0';
    error.value = null;
  } catch (e: any) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

onMounted(load);

const imageUrl = computed(() => `/api/recap/image?v=${imageVersion.value}`);

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function formatMinutes(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest >= 5 ? `${h} h ${String(rest).padStart(2, '0')}` : `${h} h`;
}

function shortDate(iso: string): string {
  return new Intl.DateTimeFormat('fr-FR', {
    day: 'numeric',
    month: 'short',
    timeZone: 'Europe/Paris',
  }).format(new Date(iso));
}

const generatedLabel = computed(() =>
  generatedAt.value
    ? new Intl.DateTimeFormat('fr-FR', {
        dateStyle: 'short',
        timeStyle: 'short',
        timeZone: 'Europe/Paris',
      }).format(new Date(generatedAt.value))
    : null,
);

/**
 * Convertit le SVG en PNG dans le navigateur.
 *
 * POURQUOI ICI : la fonction serverless n'embarque aucune bibliothèque de
 * rasterisation (sharp/canvas pèsent des dizaines de Mo). Le navigateur sait
 * le faire nativement, et les jaquettes étant embarquées en data URI, le
 * tirage ne « tache » pas le canvas : toBlob fonctionne.
 */
async function downloadPng() {
  downloading.value = true;
  downloadError.value = null;
  try {
    const res = await fetch(imageUrl.value, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const svg = await res.text();

    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const objectUrl = URL.createObjectURL(blob);

    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Image illisible'));
      img.src = objectUrl;
    });

    const scale = 2;
    const width = img.naturalWidth || 1200;
    const height = img.naturalHeight || 1200;

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas indisponible');
    ctx.scale(scale, scale);
    ctx.fillStyle = '#0f1116';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    URL.revokeObjectURL(objectUrl);

    const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!png) throw new Error('Conversion PNG impossible');

    const link = document.createElement('a');
    link.href = URL.createObjectURL(png);
    link.download = `bastion-recap-${stats.value?.windowEnd ?? 'jeux'}.png`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 5000);
  } catch (e: any) {
    downloadError.value =
      e?.name === 'SecurityError'
        ? 'Le navigateur a bloqué la conversion. Utilise « Ouvrir l’image » puis clic droit → Enregistrer.'
        : (e?.message ?? 'Téléchargement impossible.');
  } finally {
    downloading.value = false;
  }
}
</script>

<template>
  <div>
    <div class="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 class="font-display text-3xl font-bold text-fg-strong">Récap’ du groupe</h1>
        <p class="mt-1 text-sm text-fg-muted">
          Ce que le serveur a joué sur les {{ stats?.days ?? 7 }} derniers jours, en une image —
          prête à partager.
        </p>
      </div>
      <div v-if="stats" class="flex flex-wrap gap-2">
        <a
          :href="imageUrl"
          target="_blank"
          rel="noopener"
          class="btn btn-ghost text-sm"
        >
          Ouvrir l’image
        </a>
        <button class="btn btn-primary text-sm" :disabled="downloading" @click="downloadPng">
          {{ downloading ? 'Conversion…' : 'Télécharger en PNG' }}
        </button>
      </div>
    </div>

    <div v-if="downloadError" class="card mb-4 border-warn bg-warn-soft text-sm text-warn">
      {{ downloadError }}
    </div>

    <div v-if="loading" class="card animate-pulse py-16 text-center text-fg-muted">
      Construction du récap’…
    </div>

    <div v-else-if="error" class="card border-danger bg-danger-soft text-sm text-danger">
      {{ error }}
    </div>

    <div v-else-if="!enabled" class="card text-sm text-fg-muted">
      Le récap’ est désactivé par l’administrateur.
    </div>

    <template v-else-if="stats">
      <!-- Chiffres clés -->
      <div class="mb-6 grid gap-3 sm:grid-cols-3">
        <div class="card">
          <p class="text-[11px] uppercase tracking-wide text-fg-faint">Joueurs actifs</p>
          <p class="font-display text-2xl font-bold text-fg-strong">
            {{ stats.totals.players }}
          </p>
        </div>
        <div class="card">
          <p class="text-[11px] uppercase tracking-wide text-fg-faint">Jeux lancés</p>
          <p class="font-display text-2xl font-bold text-fg-strong">
            {{ stats.totals.games }}
          </p>
        </div>
        <div class="card">
          <p class="text-[11px] uppercase tracking-wide text-fg-faint">Temps de jeu cumulé</p>
          <p class="font-display text-2xl font-bold text-fg-strong">
            {{ formatMinutes(stats.totals.minutes) }}
          </p>
        </div>
      </div>

      <!-- L'image publiée -->
      <section class="mb-8">
        <div class="mb-3 flex flex-wrap items-center gap-2">
          <h2 class="font-display text-lg font-semibold text-fg-strong">L’image publiée</h2>
          <span v-if="generatedLabel" class="badge bg-app-surface2 text-fg-muted">
            mise à jour le {{ generatedLabel }}
          </span>
          <span
            v-if="stats.mode === 'estimated'"
            class="badge bg-warn-soft text-warn"
            title="Steam ne fournit pas d'historique par jour : en attendant les premiers relevés, les chiffres sont extrapolés des 14 derniers jours."
          >
            estimation
          </span>
        </div>

        <div class="card overflow-hidden p-0">
          <img
            :src="imageUrl"
            :alt="`Récap des ${stats.days} derniers jours`"
            class="block h-auto w-full"
          />
        </div>

        <p class="mt-2 text-[11px] leading-relaxed text-fg-faint">
          Données Steam des membres du serveur. Les comptes « famille » sont exclus : leur temps de
          jeu appartient à quelqu’un d’autre.
          <template v-if="stats.mode === 'measured' && stats.coverageDays < stats.days">
            Historique mesuré depuis le {{ shortDate(`${stats.historyStart}T12:00:00Z`) }} — il
            s’allonge à chaque synchronisation.
          </template>
        </p>
      </section>

      <!-- Top détaillé -->
      <section class="mb-8">
        <h2 class="mb-3 font-display text-lg font-semibold text-fg-strong">
          Les plus joués
          <span class="ml-2 badge bg-app-surface2 text-fg-muted">{{ stats.top.length }}</span>
        </h2>

        <div v-if="stats.top.length" class="card divide-y divide-line p-0">
          <div
            v-for="(game, i) in stats.top"
            :key="game.appid"
            class="flex items-center gap-3 p-3"
          >
            <span class="w-6 shrink-0 text-center font-display text-lg font-bold text-gold">
              {{ i + 1 }}
            </span>
            <img
              v-if="game.headerImage"
              :src="game.headerImage"
              :alt="game.name"
              class="h-[42px] w-[90px] shrink-0 rounded object-cover ring-1 ring-line"
              loading="lazy"
            />
            <div class="min-w-0 flex-1">
              <a
                :href="`https://store.steampowered.com/app/${game.appid}`"
                target="_blank"
                rel="noopener"
                class="block truncate text-sm font-semibold text-fg-strong hover:text-gold"
              >
                {{ game.name }}
              </a>
              <p class="truncate text-[11px] text-fg-faint">
                {{ game.players.map((p) => p.name).join(', ') || '—' }}
              </p>
            </div>
            <span class="shrink-0 text-sm font-semibold text-fg-muted">
              {{ formatMinutes(game.minutes) }}
            </span>
          </div>
        </div>
        <div v-else class="card py-8 text-center text-fg-muted">
          Aucune partie enregistrée sur la période.
        </div>
      </section>

      <!-- Tous les jeux lancés -->
      <section>
        <h2 class="mb-3 font-display text-lg font-semibold text-fg-strong">
          Tous les jeux lancés
          <span class="ml-2 badge bg-app-surface2 text-fg-muted">{{ stats.launched.length }}</span>
        </h2>

        <div v-if="stats.launched.length" class="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          <a
            v-for="game in stats.launched"
            :key="game.appid"
            :href="`https://store.steampowered.com/app/${game.appid}`"
            target="_blank"
            rel="noopener"
            class="flex items-center gap-2 rounded-md border border-line bg-app-surface px-3 py-2 text-sm transition hover:border-brand/50"
          >
            <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-gold"></span>
            <span class="min-w-0 flex-1 truncate text-fg">{{ game.name }}</span>
            <span class="shrink-0 text-[11px] text-fg-faint">
              {{ game.minutes > 0 ? formatMinutes(game.minutes) : 'lancé' }}
            </span>
          </a>
        </div>
        <div v-else class="card py-8 text-center text-fg-muted">
          Aucun jeu lancé sur la période.
        </div>

        <p class="mt-4 text-[11px] text-fg-faint">
          {{ plural(stats.totals.players, 'membre actif') }} ·
          {{ formatMinutes(stats.totals.minutes) }} de jeu cumulées.
        </p>
      </section>
    </template>
  </div>
</template>
