<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { apiGet, apiPost } from '../lib/api';

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

function channelWarning(c: Channel): string | null {
  if (c.canView === false) return 'bot sans accès';
  if (c.canConnect === false) return 'bot sans « Se connecter »';
  return null;
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

    if (!channelId.value) {
      // On privilégie un salon accessible, mais on ne vide pas la liste quand
      // aucun ne l'est : l'admin doit pouvoir tenter sa chance (le calcul des
      // permissions est une aide, pas un couperet).
      const preferred = usableChannels.value[0] ?? channels.value[0];
      if (preferred) channelId.value = preferred.id;
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
  imageData.value = null;
  imageError.value = null;
}

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
              v-if="imageData"
              class="relative overflow-hidden rounded-lg border border-line"
            >
              <img
                :src="imageData"
                alt="Aperçu de la bannière"
                class="aspect-video w-full object-cover"
              />
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
              Recadrée en 1280×720 et compressée automatiquement.
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
              <option v-for="c in channels" :key="c.id" :value="c.id">
                {{ c.name }}<template v-if="channelWarning(c)"> — ⚠ {{ channelWarning(c) }}</template>
              </option>
            </select>
            <p v-if="channelsError" class="mt-1 text-xs text-danger">{{ channelsError }}</p>
            <p
              v-else-if="!loadingChannels && blockedChannels.length > 0"
              class="mt-1 text-xs text-warn"
            >
              ⚠ {{ blockedChannels.length }} salon(s) où le bot n'a pas « Se connecter ».
              Discord exige cette permission <strong>sur le salon</strong> pour un
              événement vocal. Dans le salon : Permissions → « Ajouter des membres ou
              des rôles » → choisir le rôle <strong>Robots</strong> (ou steam-match) →
              cocher <strong>Se connecter</strong> → Enregistrer. Puis
              <button type="button" class="underline hover:no-underline" @click="loadChannels">
                actualise la liste
              </button>. « Lieu externe » fonctionne sans cette permission.
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
