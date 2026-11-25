<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { apiGet, apiPost, formatPrice, hideBrokenImage } from '../lib/api';

/**
 * Modal de création d'un événement sur le serveur Discord.
 *
 * Le formulaire reste volontairement simple : un nom, une date, une durée, et
 * un lieu (salon vocal ou adresse externe). Discord accepte bien d'autres
 * champs (bannière, événement privé…), mais ils n'ont pas leur place dans un
 * formulaire qu'on veut remplir en trente secondes.
 *
 * Le composant est monté par le parent avec `v-if`, il n'a donc pas de prop
 * « open » : sa simple existence signifie qu'il est ouvert.
 */

interface Channel {
  id: string;
  name: string;
  type: number;
  /** Permissions effectives du bot sur ce salon (calculées côté serveur). */
  canView?: boolean;
  canConnect?: boolean;
  /**
   * Rôles qui ouvrent « Se connecter » sur ce salon sans que le bot les porte.
   * Attribuer l'un d'eux au bot suffit : pas besoin de toucher aux permissions
   * d'un salon que le bot ne peut justement pas administrer.
   */
  grantingRoles?: { id: string; name: string }[];
}

interface GameHit {
  appid: number;
  name: string;
  headerImage: string;
  shortDescription: string | null;
  steamPrice: number | null;
  steamDiscount: number | null;
  steamCurrency: string;
  cheapestPrice: number | null;
  cheapestStore: string | null;
  cheapestCurrency: string;
}

interface BotInfo {
  id: string;
  username: string;
  canCreateEvents: boolean;
  canManageEvents: boolean;
}

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'created', payload: { name: string }): void;
}>();

/* ── Champs ─────────────────────────────────────────────────────────── */

const name = ref('');
const description = ref('');
const kind = ref<'voice' | 'external'>('voice');
const channelId = ref('');
const location = ref('');
const date = ref('');
const time = ref('20:30');
const duration = ref(120); // minutes ; 0 = pas d'heure de fin

/* ── Salons vocaux ──────────────────────────────────────────────────── */

const channels = ref<Channel[]>([]);
const channelsError = ref<string | null>(null);
const loadingChannels = ref(true);
const botConfigured = ref(true);
// Identité et permissions du bot réellement utilisé par le site : un 403
// s'explique presque toujours par un jeton qui ne correspond pas au bot
// autorisé sur le serveur, d'où l'affichage explicite.
const bot = ref<BotInfo | null>(null);
const guildId = ref<string | null>(null);

const permissionBlocked = computed(() => bot.value !== null && !bot.value.canCreateEvents);

/**
 * Salons réellement utilisables pour un événement vocal : Discord exige que le
 * bot puisse voir le salon ET s'y connecter. Les autres sont affichés barrés,
 * avec la raison, plutôt que de laisser l'admin découvrir un 403 après coup.
 */
const usableChannels = computed(() =>
  channels.value.filter((c) => c.canView !== false && c.canConnect !== false),
);

const blockedChannels = computed(() =>
  channels.value.filter((c) => c.canView === false || c.canConnect === false),
);

/** Y a-t-il au moins un salon que le bot peut réellement rejoindre ? */
const hasUsableChannel = computed(() => usableChannels.value.length > 0);

function channelWarning(c: Channel): string | null {
  if (c.canView === false) return 'bot sans accès';
  if (c.canConnect === false) return 'bot sans « Se connecter »';
  return null;
}

/** Rôles à attribuer au bot pour débloquer ce salon, en clair. */
function grantingRoleNames(c: Channel): string {
  return (c.grantingRoles ?? []).map((r) => r.name).join(' ou ');
}

async function loadChannels() {
  loadingChannels.value = true;
  channelsError.value = null;
  try {
    const r = await apiGet<{
      configured: boolean;
      guildId: string | null;
      channels: Channel[];
      bot: BotInfo | null;
      error: string | null;
    }>('/api/events/channels');

    botConfigured.value = r.configured;
    channels.value = r.channels ?? [];
    channelsError.value = r.error ?? null;
    bot.value = r.bot ?? null;
    guildId.value = r.guildId ?? null;

    // Le salon retenu doit être réellement utilisable : sinon l'envoi finirait
    // en 403 après avoir laissé croire que tout était en ordre. Les salons
    // bloqués restent visibles dans la liste (grisés) avec la raison.
    const stillUsable = usableChannels.value.some((c) => c.id === channelId.value);
    if (!stillUsable) {
      // Aucun salon utilisable : on garde le premier pour laisser l'admin
      // tenter (Discord tranchera), la liste n'est grisée que s'il existe une
      // alternative qui marche.
      channelId.value = usableChannels.value[0]?.id ?? channels.value[0]?.id ?? '';
    }

    // Aucun salon du tout : « lieu externe » est la seule option possible.
    if (r.configured && channels.value.length === 0) {
      kind.value = 'external';
    }
  } catch (e: any) {
    channelsError.value = e.message;
  } finally {
    loadingChannels.value = false;
  }
}

/* ── Jeu associé ────────────────────────────────────────────────────── */

/**
 * Champ de recherche + sélection d'un jeu de la bibliothèque.
 *
 * Une fois le jeu choisi, on remplit la description (résumé Steam puis prix
 * Steam et prix en clé) et on laisse le serveur poser la jaquette en bannière :
 * le navigateur ne peut pas encoder une image d'un autre domaine en data URI.
 */
const gameQuery = ref('');
const gameResults = ref<GameHit[]>([]);
const gameSearching = ref(false);
const gameError = ref<string | null>(null);
const showGameResults = ref(false);
const selectedGame = ref<GameHit | null>(null);
/** Texte exact inséré par le jeu, pour savoir quoi retirer ensuite. */
const appliedGameBlock = ref<string | null>(null);

let searchTimer: ReturnType<typeof setTimeout> | undefined;
let searchSeq = 0;

function onGameInput() {
  clearTimeout(searchTimer);
  const q = gameQuery.value.trim();

  // Modifier le texte après sélection retire le jeu : le formulaire ne doit
  // pas prétendre qu'un jeu est encore associé alors que le nom a changé.
  if (selectedGame.value && q !== selectedGame.value.name) {
    selectedGame.value = null;
  }

  if (q.length < 2) {
    gameResults.value = [];
    gameSearching.value = false;
    showGameResults.value = false;
    return;
  }

  gameSearching.value = true;
  searchTimer = setTimeout(() => void searchGames(q), 250);
}

async function searchGames(q: string) {
  const seq = ++searchSeq;
  try {
    const r = await apiGet<{ games: GameHit[] }>(
      `/api/events/game-search?q=${encodeURIComponent(q)}`,
    );
    if (seq !== searchSeq) return; // réponse obsolète
    gameResults.value = r.games ?? [];
    gameError.value = null;
    showGameResults.value = true;
  } catch (e: any) {
    if (seq !== searchSeq) return;
    gameError.value = e.message ?? 'Recherche impossible.';
  } finally {
    if (seq === searchSeq) gameSearching.value = false;
  }
}

/** Prix (« non disponible » plutôt qu'un vide inquiétant). */
function steamPriceLabel(g: GameHit): string {
  if (g.steamPrice == null) return 'non disponible';
  const base = formatPrice(g.steamPrice, g.steamCurrency || 'EUR');
  return g.steamDiscount ? `${base} (−${g.steamDiscount} %)` : base;
}

function keyPriceLabel(g: GameHit): string {
  if (g.cheapestPrice == null) return 'non disponible';
  const base = formatPrice(g.cheapestPrice, g.cheapestCurrency || 'EUR');
  return g.cheapestStore ? `${base} (${g.cheapestStore})` : base;
}

/** Bloc ajouté en fin de description : résumé du jeu, puis les deux prix. */
function gameBlock(g: GameHit): string {
  const prices = `Prix Steam : ${steamPriceLabel(g)}\nPrix en clé : ${keyPriceLabel(g)}`;

  let intro = (g.shortDescription ?? '').trim();
  // La description Discord est plafonnée à 1000 caractères : on réserve la
  // place des prix et de la mise en forme.
  const room = 1000 - prices.length - 2;
  if (intro.length > room) {
    intro = `${intro.slice(0, Math.max(0, room - 1)).trimEnd()}…`;
  }

  return intro ? `${intro}\n\n${prices}` : prices;
}

/** Insère (ou remplace) le bloc du jeu en fin de description. */
function writeGameBlock(g: GameHit) {
  let base = description.value;
  if (appliedGameBlock.value) {
    base = base.replace(appliedGameBlock.value, '');
  }
  base = base.trimEnd();

  const block = gameBlock(g);
  appliedGameBlock.value = block;
  description.value = base ? `${base}\n\n${block}` : block;
}

const loadingGameInfo = ref(false);

async function applyGame(g: GameHit) {
  selectedGame.value = g;
  gameQuery.value = g.name;
  gameResults.value = [];
  showGameResults.value = false;
  gameError.value = null;

  // Nom : on complète seulement s'il est vide, jamais à la place d'une saisie.
  if (name.value.trim().length === 0) {
    name.value = `Soirée ${g.name}`;
  }

  // La liste de recherche ne transporte pas le résumé Steam (le cache peut
  // être vide) : on demande la fiche complète, récupérée et mémorisée côté
  // serveur au besoin. Le texte déjà présent reste affiché entre-temps.
  loadingGameInfo.value = true;
  try {
    const r = await apiGet<{ game: GameHit }>(
      `/api/events/game-info?appid=${g.appid}`,
    );
    // Un autre jeu a été choisi entre-temps : on n'écrase pas son bloc.
    if (selectedGame.value?.appid !== g.appid) return;
    const full = r.game;
    selectedGame.value = full;
    writeGameBlock(full);
  } catch {
    if (selectedGame.value?.appid !== g.appid) return;
    writeGameBlock(g); // prix au moins ; pas de résumé si Steam ne répond pas
  } finally {
    if (selectedGame.value?.appid === g.appid) loadingGameInfo.value = false;
  }
}

function clearGame() {
  if (appliedGameBlock.value) {
    description.value = description.value
      .replace(appliedGameBlock.value, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  appliedGameBlock.value = null;
  selectedGame.value = null;
  gameQuery.value = '';
  gameResults.value = [];
  showGameResults.value = false;
  gameError.value = null;
}

/* ── Bannière ───────────────────────────────────────────────────────── */

const imageData = ref<string | null>(null);
const imageError = ref<string | null>(null);
const processingImage = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);

/**
 * Redimensionne et réencode la bannière dans le navigateur.
 *
 * Discord refuse les images non carrées mal cadrées selon les cas, et sa
 * limite de taille est basse : on cadre donc en 16:9 (1280×720) et on encode
 * en JPEG. Envoyer le fichier d'origine tel quel produirait un 400 opaque.
 */
function toCoverDataUri(file: File): Promise<string> {
  const W = 1280;
  const H = 720;

  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();

    img.onload = () => {
      URL.revokeObjectURL(url);
      try {
        const canvas = document.createElement('canvas');
        canvas.width = W;
        canvas.height = H;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Canvas indisponible');

        // Cadrage « cover » : on remplit le 16:9 en centrant, sans déformer.
        const scale = Math.max(W / img.width, H / img.height);
        const dw = img.width * scale;
        const dh = img.height * scale;

        ctx.fillStyle = '#0b0d1a';
        ctx.fillRect(0, 0, W, H);
        ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);

        resolve(canvas.toDataURL('image/jpeg', 0.85));
      } catch (err) {
        reject(err);
      }
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Image illisible'));
    };

    img.src = url;
  });
}

async function onFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  // On vide la sélection pour pouvoir rechoisir le même fichier ensuite.
  input.value = '';
  if (!file) return;

  imageError.value = null;

  if (!file.type.startsWith('image/')) {
    imageError.value = 'Choisis un fichier image (PNG, JPEG ou WebP).';
    return;
  }
  if (file.size > 8_000_000) {
    imageError.value = 'Image trop lourde (8 Mo maximum avant compression).';
    return;
  }

  processingImage.value = true;
  try {
    imageData.value = await toCoverDataUri(file);
  } catch {
    imageError.value = 'Impossible de lire cette image.';
  } finally {
    processingImage.value = false;
  }
}

function removeImage() {
  if (imageData.value) {
    imageData.value = null;
    imageError.value = null;
    return;
  }
  // La bannière venait de la jaquette du jeu : retirer la bannière revient à
  // retirer le jeu (et donc sa description et ses prix, qui vont ensemble).
  clearGame();
}

/** Image réellement affichée en aperçu : fichier choisi, sinon jaquette du jeu. */
const bannerPreview = computed(() => imageData.value ?? selectedGame.value?.headerImage ?? null);
const bannerFromGame = computed(() => !imageData.value && selectedGame.value !== null);

/* ── Dates ──────────────────────────────────────────────────────────── */

/** Date locale au format attendu par <input type="date">. */
function dateInputValue(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function resetForm() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(20, 30, 0, 0);

  name.value = '';
  description.value = '';
  kind.value = 'voice';
  channelId.value = '';
  location.value = '';
  date.value = dateInputValue(tomorrow);
  time.value = '20:30';
  duration.value = 120;
  imageData.value = null;
  imageError.value = null;
  appliedGameBlock.value = null;
  selectedGame.value = null;
  gameQuery.value = '';
  gameResults.value = [];
  showGameResults.value = false;
  gameError.value = null;
  error.value = null;
  attempted.value = false;
}

/**
 * Interprétation en heure LOCALE : `new Date('2026-01-01T20:30')` (sans Z)
 * est traité comme l'heure du navigateur, ce qui est exactement ce qu'on veut
 * pour « l'événement de 20 h 30 ».
 */
const startAt = computed<Date | null>(() => {
  if (!date.value || !time.value) return null;
  const d = new Date(`${date.value}T${time.value}:00`);
  return Number.isNaN(d.getTime()) ? null : d;
});

const endAt = computed<Date | null>(() => {
  const s = startAt.value;
  if (!s || !duration.value) return null;
  return new Date(s.getTime() + duration.value * 60_000);
});

/* ── Validation côté navigateur ─────────────────────────────────────── */

const attempted = ref(false);
const sending = ref(false);
const error = ref<string | null>(null);

const localError = computed<string | null>(() => {
  if (name.value.trim().length < 2) return 'Donne un nom à l’événement (2 caractères minimum).';
  if (name.value.trim().length > 100) return 'Le nom ne peut pas dépasser 100 caractères.';
  if (description.value.trim().length > 1000) {
    return 'La description ne peut pas dépasser 1000 caractères.';
  }

  const s = startAt.value;
  if (!s) return 'Choisis une date et une heure.';
  if (s.getTime() < Date.now() + 60_000) {
    return 'La date de début doit être dans le futur.';
  }

  if (kind.value === 'voice') {
    if (!channelId.value) return 'Choisis un salon vocal.';
  } else if (location.value.trim().length < 2) {
    return 'Indique un lieu ou un lien pour l’événement.';
  }

  return null;
});

const canSubmit = computed(
  () => !localError.value && !sending.value && !permissionBlocked.value && !processingImage.value,
);

/* ── Aperçu lisible ─────────────────────────────────────────────────── */

const dateFmt = new Intl.DateTimeFormat('fr-FR', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});
const timeFmt = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' });

const preview = computed(() => {
  const s = startAt.value;
  if (!s) return null;

  const place =
    kind.value === 'voice'
      ? channels.value.find((c) => c.id === channelId.value)?.name ?? 'salon vocal'
      : location.value.trim() || 'lieu à préciser';

  const dur = duration.value
    ? ` · ${duration.value >= 120 ? `${duration.value / 60} h` : `${duration.value} min`}`
    : '';

  return `${dateFmt.format(s)} à ${timeFmt.format(s)}${dur} · ${place}`;
});

/* ── Envoi ──────────────────────────────────────────────────────────── */

async function submit() {
  attempted.value = true;
  error.value = null;
  if (localError.value) return;

  sending.value = true;
  try {
    const r = await apiPost<{ ok: boolean; event: { name: string } }>('/api/events/create', {
      name: name.value.trim(),
      description: description.value.trim() || null,
      startAt: startAt.value!.toISOString(),
      endAt: endAt.value ? endAt.value.toISOString() : null,
      entityType: kind.value === 'voice' ? 2 : 3,
      channelId: kind.value === 'voice' ? channelId.value : null,
      location: kind.value === 'external' ? location.value.trim() : null,
      image: imageData.value,
      // Le serveur s'en sert pour poser la jaquette si aucune image n'a été
      // choisie à la main.
      gameAppid: selectedGame.value?.appid ?? null,
    });

    emit('created', r.event);
    emit('close');
  } catch (e: any) {
    error.value = e.message ?? 'Création impossible.';
  } finally {
    sending.value = false;
  }
}

/* ── Ouverture / fermeture ──────────────────────────────────────────── */

const nameInput = ref<HTMLInputElement | null>(null);

function close() {
  if (sending.value) return;
  emit('close');
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') close();
}

onMounted(() => {
  resetForm();
  loadChannels();
  document.body.style.overflow = 'hidden';
  window.addEventListener('keydown', onKeydown);
  nextTick(() => nameInput.value?.focus());
});

onBeforeUnmount(() => {
  document.body.style.overflow = '';
  window.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <Teleport to="body">
    <div
      class="fixed inset-0 z-50 overflow-y-auto bg-black/70 p-4 backdrop-blur-sm"
      @click.self="close"
    >
      <div
        class="card mx-auto my-6 w-full max-w-lg"
        role="dialog"
        aria-modal="true"
        aria-labelledby="evt-create-title"
      >
        <!-- En-tête -->
        <div class="flex items-start gap-3">
          <div class="min-w-0 flex-1">
            <h2 id="evt-create-title" class="font-display text-lg font-bold text-fg-strong">
              Créer un événement
            </h2>
            <p class="mt-1 text-xs text-fg-muted">
              Il sera créé sur le serveur Discord et apparaîtra ici immédiatement.
            </p>
          </div>
          <button
            type="button"
            class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-line text-fg-muted transition hover:border-danger hover:text-danger"
            aria-label="Fermer"
            @click="close"
          >
            <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form class="mt-4 space-y-4" @submit.prevent="submit">
          <!-- Nom -->
          <div>
            <label for="evt-name" class="mb-1 block text-xs font-medium text-fg-muted">
              Nom de l'événement
            </label>
            <input
              id="evt-name"
              ref="nameInput"
              v-model="name"
              type="text"
              maxlength="100"
              placeholder="Soirée survie — Valheim"
              class="input"
            />
          </div>

          <!-- Jeu (préremplit description, bannière et prix) -->
          <div>
            <label for="evt-game" class="mb-1 block text-xs font-medium text-fg-muted">
              Jeu <span class="text-fg-faint">(facultatif)</span>
            </label>

            <div class="relative">
              <svg
                class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-faint"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                aria-hidden="true"
              >
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" />
              </svg>
              <input
                id="evt-game"
                v-model="gameQuery"
                type="text"
                autocomplete="off"
                placeholder="Rechercher un jeu de la bibliothèque…"
                class="input pl-9"
                @input="onGameInput"
              />
            </div>

            <p v-if="gameError" class="mt-1 text-xs text-danger">{{ gameError }}</p>
            <p v-else-if="gameSearching" class="mt-1 text-xs text-fg-faint">Recherche…</p>
            <p v-else-if="loadingGameInfo" class="mt-1 text-xs text-fg-faint">
              Chargement de la fiche Steam…
            </p>

            <ul
              v-if="showGameResults && gameResults.length > 0"
              class="mt-1 max-h-64 divide-y divide-line overflow-y-auto rounded-lg border border-line bg-app-elevated"
            >
              <li v-for="g in gameResults" :key="g.appid">
                <button
                  type="button"
                  class="flex w-full items-center gap-3 px-3 py-2 text-left transition hover:bg-brand-soft"
                  @click="applyGame(g)"
                >
                  <img
                    :src="g.headerImage"
                    alt=""
                    class="h-8 w-14 shrink-0 rounded object-cover"
                    loading="lazy"
                    @error="hideBrokenImage"
                  />
                  <span class="min-w-0 flex-1">
                    <span class="block truncate text-sm text-fg-strong">{{ g.name }}</span>
                    <span class="block text-[11px] text-fg-faint">
                      Steam {{ steamPriceLabel(g) }} · clé {{ keyPriceLabel(g) }}
                    </span>
                  </span>
                </button>
              </li>
            </ul>
            <p
              v-else-if="showGameResults && !gameSearching && gameQuery.trim().length >= 2"
              class="mt-1 text-xs text-fg-faint"
            >
              Aucun jeu de la bibliothèque ne correspond.
            </p>

            <div v-if="selectedGame" class="mt-2 flex flex-wrap items-center gap-2 text-xs">
              <span class="rounded bg-brand-soft px-2 py-0.5 font-medium text-fg-strong">
                {{ selectedGame.name }}
              </span>
              <button
                type="button"
                class="text-fg-muted underline transition hover:text-fg-strong hover:no-underline"
                @click="clearGame"
              >
                retirer
              </button>
              <span class="text-fg-faint">
                {{ loadingGameInfo ? 'récupération du résumé…' : 'description, jaquette et prix ajoutés' }}
              </span>
            </div>
          </div>

          <!-- Description -->
          <div>
            <label for="evt-desc" class="mb-1 block text-xs font-medium text-fg-muted">
              Description <span class="text-fg-faint">(facultatif)</span>
            </label>
            <textarea
              id="evt-desc"
              v-model="description"
              rows="3"
              maxlength="1000"
              placeholder="On se retrouve pour une session détendue, micro conseillé."
              class="input resize-none"
            ></textarea>
          </div>

          <!-- Bannière -->
          <div>
            <span class="mb-1 block text-xs font-medium text-fg-muted">
              Bannière <span class="text-fg-faint">(facultatif)</span>
            </span>

            <div
              v-if="bannerPreview"
              class="relative overflow-hidden rounded-lg border border-line"
            >
              <img
                :src="bannerPreview"
                alt="Aperçu de la bannière"
                class="aspect-video w-full object-cover"
              />
              <span
                v-if="bannerFromGame"
                class="absolute left-2 top-2 rounded bg-black/60 px-2 py-0.5 text-[11px] text-white"
              >
                Jaquette de {{ selectedGame?.name }}
              </span>
              <div
                class="absolute inset-x-0 bottom-0 flex justify-end gap-2 bg-gradient-to-t from-black/75 to-transparent p-2"
              >
                <button
                  type="button"
                  class="rounded-md border border-white/30 bg-black/40 px-2 py-1 text-[11px] text-white transition hover:bg-black/60"
                  @click="fileInput?.click()"
                >
                  Remplacer
                </button>
                <button
                  type="button"
                  class="rounded-md border border-white/30 bg-black/40 px-2 py-1 text-[11px] text-white transition hover:bg-black/60"
                  @click="removeImage"
                >
                  Retirer
                </button>
              </div>
            </div>

            <button
              v-else
              type="button"
              class="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-line-strong px-3 py-4 text-xs text-fg-muted transition hover:border-brand hover:text-fg-strong disabled:opacity-50"
              :disabled="processingImage"
              @click="fileInput?.click()"
            >
              <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <rect x="3" y="4" width="18" height="16" rx="2" />
                <circle cx="8.5" cy="9.5" r="1.5" />
                <path d="m21 15-4.5-4.5L7 20" />
              </svg>
              {{ processingImage ? 'Traitement…' : 'Choisir une image (16:9)' }}
            </button>

            <input
              ref="fileInput"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              class="hidden"
              @change="onFile"
            />

            <p v-if="imageError" class="mt-1 text-xs text-danger">{{ imageError }}</p>
            <p v-else class="mt-1 text-[11px] text-fg-faint">
              <template v-if="bannerFromGame">
                Jaquette Steam du jeu sélectionné, ajoutée automatiquement.
              </template>
              <template v-else>Recadrée en 1280×720 et compressée automatiquement.</template>
            </p>
          </div>

          <!-- Type -->
          <div>
            <span class="mb-1 block text-xs font-medium text-fg-muted">Lieu</span>
            <div class="grid grid-cols-2 gap-2">
              <button
                type="button"
                class="rounded-lg border px-3 py-2 text-left text-sm transition"
                :class="
                  kind === 'voice'
                    ? 'border-brand bg-brand-soft text-fg-strong'
                    : 'border-line bg-app-elevated text-fg-muted hover:border-line-strong'
                "
                @click="kind = 'voice'"
              >
                <span class="block font-medium">Salon vocal</span>
                <span class="text-[11px] text-fg-faint">Discord, entre membres</span>
              </button>
              <button
                type="button"
                class="rounded-lg border px-3 py-2 text-left text-sm transition"
                :class="
                  kind === 'external'
                    ? 'border-brand bg-brand-soft text-fg-strong'
                    : 'border-line bg-app-elevated text-fg-muted hover:border-line-strong'
                "
                @click="kind = 'external'"
              >
                <span class="block font-medium">Lieu externe</span>
                <span class="text-[11px] text-fg-faint">Lien, adresse, ailleurs</span>
              </button>
            </div>
          </div>

          <!-- Salon vocal -->
          <div v-if="kind === 'voice'">
            <label for="evt-channel" class="mb-1 block text-xs font-medium text-fg-muted">
              Salon
            </label>
            <select
              id="evt-channel"
              v-model="channelId"
              class="input"
              :disabled="loadingChannels || channels.length === 0"
            >
              <option v-if="loadingChannels" value="">Chargement des salons…</option>
              <option v-else-if="channels.length === 0" value="">
                Aucun salon vocal disponible
              </option>
              <option
                v-for="c in channels"
                :key="c.id"
                :value="c.id"
                :disabled="hasUsableChannel && channelWarning(c) !== null"
              >
                {{ c.name }}<template v-if="channelWarning(c)"> — {{ channelWarning(c) }}</template>
              </option>
            </select>
            <p v-if="channelsError" class="mt-1 text-xs text-danger">{{ channelsError }}</p>
            <p
              v-else-if="!loadingChannels && blockedChannels.length > 0"
              class="mt-1 text-xs text-warn"
            >
              <span v-for="c in blockedChannels" :key="c.id" class="block">
                <strong>{{ c.name }}</strong> :
                <template v-if="grantingRoleNames(c)">
                  donne le rôle <strong>{{ grantingRoleNames(c) }}</strong> au bot —
                  Paramètres du serveur → Membres → steam-match → Rôles.
                </template>
                <template v-else-if="c.canView === false">
                  le bot ne voit pas ce salon.
                </template>
                <template v-else>
                  aucun rôle du salon n'accorde « Se connecter » au bot.
                </template>
              </span>
              <button type="button" class="underline hover:no-underline" @click="loadChannels">
                actualiser la liste
              </button>
            </p>
            <p v-else-if="!loadingChannels && channels.length === 0" class="mt-1 text-xs text-fg-faint">
              Aucun salon vocal n'est visible par le bot. Utilise « Lieu externe », ou
              vérifie les permissions du bot.
            </p>
          </div>

          <!-- Lieu externe -->
          <div v-else>
            <label for="evt-location" class="mb-1 block text-xs font-medium text-fg-muted">
              Lieu ou lien
            </label>
            <input
              id="evt-location"
              v-model="location"
              type="text"
              maxlength="100"
              placeholder="https://… ou « Bar Le D20, Lyon »"
              class="input"
            />
          </div>

          <!-- Date / heure / durée -->
          <div class="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div>
              <label for="evt-date" class="mb-1 block text-xs font-medium text-fg-muted">
                Date
              </label>
              <input id="evt-date" v-model="date" type="date" class="input" />
            </div>
            <div>
              <label for="evt-time" class="mb-1 block text-xs font-medium text-fg-muted">
                Heure
              </label>
              <input id="evt-time" v-model="time" type="time" class="input" />
            </div>
            <div class="col-span-2 sm:col-span-1">
              <label for="evt-duration" class="mb-1 block text-xs font-medium text-fg-muted">
                Durée
              </label>
              <select id="evt-duration" v-model.number="duration" class="input">
                <option :value="60">1 heure</option>
                <option :value="90">1 h 30</option>
                <option :value="120">2 heures</option>
                <option :value="180">3 heures</option>
                <option :value="240">4 heures</option>
                <option :value="360">6 heures</option>
                <option :value="0">Sans heure de fin</option>
              </select>
            </div>
          </div>

          <!-- Aperçu -->
          <div v-if="preview" class="rounded-lg border border-line bg-app-elevated px-3 py-2">
            <p class="text-[11px] uppercase tracking-wide text-fg-faint">Aperçu</p>
            <p class="mt-0.5 text-sm text-fg">{{ preview }}</p>
          </div>

          <!-- Erreurs -->
          <div v-if="error" class="alert alert-error text-xs">{{ error }}</div>
          <div
            v-else-if="attempted && localError"
            class="alert alert-warn text-xs"
          >
            {{ localError }}
          </div>

          <div v-if="!botConfigured" class="alert alert-warn text-xs">
            Le bot Discord n'est pas configuré : la création sera refusée.
            Renseigne <code>DISCORD_BOT_TOKEN</code> et <code>DISCORD_GUILD_ID</code>.
          </div>

          <!-- Le bot réellement utilisé n'a pas le droit de créer -->
          <div v-else-if="permissionBlocked" class="alert alert-error text-xs">
            <p class="font-semibold">Le bot ne peut pas créer d'événements</p>
            <p class="mt-1">
              Bot utilisé par le site :
              <strong>{{ bot?.username }}</strong>
              <span class="text-fg-faint">(id {{ bot?.id }})</span>
              sur le serveur
              <code class="text-fg">{{ guildId }}</code
              >. Il lui manque la permission « Créer des événements ».
            </p>
            <p class="mt-1">
              Paramètres du serveur → Rôles → rôle de ce bot → active
              « Créer des événements », puis recharge la page.
            </p>
            <p v-if="bot?.canManageEvents" class="mt-1 text-fg-faint">
              « Gérer les événements » est déjà accordée : Discord exige les deux.
            </p>
            <p class="mt-1 text-fg-faint">
              Si l'identifiant du bot ci-dessus n'est pas celui que tu as
              autorisé sur ton serveur, le jeton de production appartient à une
              autre application Discord.
            </p>
          </div>

          <!-- Actions -->
          <div class="flex flex-wrap items-center justify-end gap-2 border-t border-line pt-4">
            <span v-if="bot" class="mr-auto text-[11px] text-fg-faint">
              via {{ bot.username }}
            </span>
            <button type="button" class="btn-ghost text-sm" @click="close">Annuler</button>
            <button type="submit" class="btn-primary text-sm" :disabled="!canSubmit">
              {{ sending ? 'Création…' : 'Créer sur Discord' }}
            </button>
          </div>
        </form>
      </div>
    </div>
  </Teleport>
</template>
