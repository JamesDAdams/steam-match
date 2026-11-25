<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { apiGet, apiPost } from '../lib/api';

interface Allowed {
  discordId: string;
  note: string | null;
  addedBy: string | null;
  createdAt: string;
}

interface Known {
  discordId: string;
  username: string;
  globalName: string | null;
  avatarUrl: string | null;
  lastLoginAt: string | null;
  isAllowed: boolean;
  isAdmin: boolean;
  isMember: boolean;
  memberCheckedAt: string | null;
  hasSteam: boolean;
  steam: { steamid: string; personaName: string | null } | null;
}

const allowed = ref<Allowed[]>([]);
const known = ref<Known[]>([]);
const admins = ref<string[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const success = ref<string | null>(null);
// Vérification d'appartenance au serveur : nécessite le bot Discord.
const botConfigured = ref(true);
const guildId = ref<string | null>(null);
const inviteUrl = ref<string | null>(null);

// Formulaire d'ajout
const input = ref('');
const note = ref('');
const saving = ref(false);

// Filtre de recherche dans la liste connue
const search = ref('');

const filteredKnown = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return known.value;
  return known.value.filter(
    (k) =>
      k.username.toLowerCase().includes(q) ||
      (k.globalName ?? '').toLowerCase().includes(q) ||
      k.discordId.includes(q) ||
      (k.steam?.personaName ?? '').toLowerCase().includes(q),
  );
});

// Les comptes jamais vus mais déjà autorisés doivent rester visibles.
const knownIds = computed(() => new Set(known.value.map((k) => k.discordId)));

async function load() {
  loading.value = true;
  error.value = null;
  try {
    const data = await apiGet<{
      ok: boolean;
      allowed: Allowed[];
      known: Known[];
      admins: string[];
      botConfigured: boolean;
      guildId: string | null;
      inviteUrl: string | null;
    }>('/api/admin/users');
    allowed.value = data.allowed ?? [];
    known.value = data.known ?? [];
    admins.value = data.admins ?? [];
    botConfigured.value = data.botConfigured !== false;
    guildId.value = data.guildId ?? null;
    inviteUrl.value = data.inviteUrl ?? null;
  } catch (e: any) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

async function addIds() {
  const raw = input.value.trim();
  if (!raw) return;

  saving.value = true;
  error.value = null;
  success.value = null;
  try {
    const ids = raw.split(/[\s,;]+/).filter(Boolean);
    const r = await apiPost<{ ok: boolean; added: string[]; count: number }>(
      '/api/admin/users',
      { discordIds: ids, note: note.value.trim() || null },
    );
    success.value = `${r.count} identifiant(s) autorisé(s).`;
    input.value = '';
    note.value = '';
    await load();
  } catch (e: any) {
    error.value = e.message;
  } finally {
    saving.value = false;
  }
}

async function removeId(id: string) {
  if (!confirm(`Retirer l'accès à ${id} ?`)) return;

  error.value = null;
  success.value = null;
  try {
    const res = await fetch(`/api/admin/users?id=${encodeURIComponent(id)}`, {
      method: 'DELETE',
      credentials: 'same-origin',
    });
    if (!res.ok) {
      const d = await res.json().catch(() => null);
      throw new Error(d?.error ?? `Erreur HTTP ${res.status}`);
    }
    success.value = `Accès retiré pour ${id}.`;
    await load();
  } catch (e: any) {
    error.value = e.message;
  }
}

function addKnown(id: string) {
  input.value = id;
  addIds();
}

function since(d: string | null) {
  if (!d) return 'jamais';
  const mins = Math.floor((Date.now() - new Date(d).getTime()) / 60000);
  if (mins < 1) return "à l'instant";
  if (mins < 60) return `il y a ${mins} min`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `il y a ${h} h`;
  return `il y a ${Math.floor(h / 24)} j`;
}

onMounted(load);
</script>

<template>
  <div class="mx-auto max-w-5xl">
    <div class="mb-6">
      <h1 class="text-2xl font-bold text-fg-strong">Administration</h1>
      <p class="mt-1 text-sm text-fg-muted">
        Les membres du serveur Discord entrent automatiquement. Cette page sert
        aux exceptions : les comptes qui ne sont pas sur le serveur.
      </p>
    </div>

    <!-- Alerte erreur / succès -->
    <div v-if="error" class="card mb-4 border-danger bg-danger-soft text-sm text-danger">
      {{ error }}
    </div>
    <div v-if="success" class="card mb-4 border-emerald-500/40 bg-emerald-500/5 text-sm text-ok">
      {{ success }}
    </div>

    <!-- État de la vérification d'appartenance -->
    <div v-if="!botConfigured" class="alert alert-warn mb-4">
      <p class="font-semibold">Vérification d'appartenance désactivée</p>
      <p class="mt-1 text-xs">
        <code class="text-warn">DISCORD_BOT_TOKEN</code> ou
        <code class="text-warn">DISCORD_GUILD_ID</code> manquant : les membres du
        serveur ne sont pas reconnus automatiquement. Seuls les comptes listés
        ci-dessous peuvent se connecter. Renseigne ces deux variables, redéploie,
        puis reconnecte-toi pour activer la vérification.
      </p>
    </div>
    <div v-else class="alert alert-info mb-4 text-xs">
      Les membres du serveur Discord
      <code v-if="guildId" class="text-brand">{{ guildId }}</code>
      sont reconnus à chaque connexion. La liste ci-dessous ajoute des personnes
      qui n'y sont pas.
      <a v-if="inviteUrl" :href="inviteUrl" target="_blank" rel="noopener" class="ml-1 underline">
        Lien d'invitation du serveur ↗
      </a>
    </div>

    <!-- Ajout -->
    <section class="card mb-6">
      <h2 class="font-semibold text-fg-strong">Autoriser un compte hors serveur</h2>
      <p class="mt-1 text-xs text-fg-faint">
        Ces comptes peuvent se connecter même s'ils ne sont pas membres du
        serveur Discord. Un ID Discord = 17 à 20 chiffres. Sur Discord : clic
        droit sur le pseudo → <em>Copier l'identifiant</em>. Tu peux coller
        plusieurs IDs séparés par des espaces ou des virgules.
      </p>

      <div class="mt-3 grid gap-3 sm:grid-cols-[1fr_auto]">
        <div class="space-y-2">
          <textarea
            v-model="input"
            rows="2"
            placeholder="123456789012345678"
            class="w-full rounded border border-line bg-app-bg px-3 py-2 font-mono text-sm text-fg placeholder:text-fg-faint focus:border-brand focus:outline-none"
          ></textarea>
          <input
            v-model="note"
            placeholder="Note (optionnel) — ex. pseudo Discord"
            class="w-full rounded border border-line bg-app-bg px-3 py-2 text-sm text-fg placeholder:text-fg-faint focus:border-brand focus:outline-none"
          />
        </div>
        <button class="btn-primary h-fit text-sm" :disabled="saving || !input.trim()" @click="addIds">
          {{ saving ? 'Ajout…' : 'Autoriser' }}
        </button>
      </div>
    </section>

    <!-- Admins définis dans l'env -->
    <section class="card mb-6 border-warn bg-warn-soft">
      <h2 class="font-semibold text-warn">Administrateur(s)</h2>
      <p class="mt-1 text-xs text-fg-muted">
        Défini(s) par la variable <code class="text-warn">DISCORD_ADMIN_ID</code>.
        Toujours autorisé(s), non modifiable(s) depuis cette page.
      </p>
      <div class="mt-2 flex flex-wrap gap-2">
        <code
          v-for="a in admins"
          :key="a"
          class="rounded border border-warn bg-app-bg/40 px-2 py-1 font-mono text-xs text-warn"
        >
          {{ a }}
        </code>
        <span v-if="admins.length === 0" class="text-xs text-danger">
          Aucun admin configuré — renseigne DISCORD_ADMIN_ID.
        </span>
      </div>
    </section>

    <!-- Liste des autorisés -->
    <section class="card mb-6">
      <h2 class="font-semibold text-fg-strong">
        Exceptions autorisées
        <span class="ml-1 text-sm font-normal text-fg-faint">({{ allowed.length }})</span>
      </h2>

      <div v-if="loading" class="mt-3 h-12 animate-pulse rounded bg-app-surface2"></div>
      <p v-else-if="allowed.length === 0" class="mt-3 text-sm text-fg-faint">
        Aucun identifiant autorisé pour le moment. Les personnes qui tentent de se
        connecter apparaîtront ci-dessous avec leur ID.
      </p>
      <ul v-else class="mt-3 divide-y divide-line">
        <li
          v-for="a in allowed"
          :key="a.discordId"
          class="flex flex-wrap items-center gap-3 py-2"
        >
          <code class="font-mono text-sm text-fg">{{ a.discordId }}</code>
          <span v-if="a.note" class="text-xs text-fg-faint">{{ a.note }}</span>
          <span v-if="knownIds.has(a.discordId) === false" class="badge bg-app-surface2 text-fg-muted">
            jamais connecté
          </span>
          <button
            class="ml-auto text-xs text-danger hover:text-danger hover:underline"
            @click="removeId(a.discordId)"
          >
            Retirer
          </button>
        </li>
      </ul>
    </section>

    <!-- Comptes déjà vus -->
    <section class="card">
      <div class="flex flex-wrap items-center gap-3">
        <h2 class="font-semibold text-fg-strong">Comptes déjà connectés</h2>
        <input
          v-model="search"
          placeholder="Rechercher…"
          class="ml-auto rounded border border-line bg-app-bg px-3 py-1.5 text-sm text-fg placeholder:text-fg-faint focus:border-brand focus:outline-none"
        />
      </div>

      <div v-if="loading" class="mt-3 h-20 animate-pulse rounded bg-app-surface2"></div>
      <p v-else-if="known.length === 0" class="mt-3 text-sm text-fg-faint">
        Personne ne s'est encore connecté.
      </p>
      <ul v-else class="mt-3 divide-y divide-line">
        <li
          v-for="k in filteredKnown"
          :key="k.discordId"
          class="flex flex-wrap items-center gap-3 py-2"
        >
          <img
            v-if="k.avatarUrl"
            :src="k.avatarUrl"
            :alt="k.username"
            class="h-8 w-8 rounded-full border border-line"
          />
          <div v-else class="h-8 w-8 rounded-full border border-line bg-app-surface2"></div>

          <div class="min-w-0">
            <p class="truncate text-sm text-fg">
              {{ k.globalName || k.username }}
              <span class="text-xs text-fg-faint">@{{ k.username }}</span>
            </p>
            <p class="font-mono text-xs text-fg-faint">{{ k.discordId }}</p>
          </div>

          <div class="ml-auto flex flex-wrap items-center gap-1">
            <span v-if="k.isAdmin" class="badge bg-warn-soft text-warn">admin</span>
            <span
              v-else-if="k.isAllowed"
              class="badge bg-ok-soft text-ok"
            >autorisé</span>
            <span v-else-if="k.isMember" class="badge bg-ok-soft text-ok">membre</span>
            <span v-else class="badge bg-danger-soft text-danger">refusé</span>

            <!-- Statut d'appartenance au serveur (vérifié via le bot) -->
            <span v-if="k.isMember" class="badge bg-app-surface2 text-ok">sur le serveur</span>
            <span v-else-if="k.memberCheckedAt" class="badge bg-app-surface2 text-fg-muted">
              hors serveur
            </span>
            <span v-else class="badge bg-app-surface2 text-fg-faint">non vérifié</span>

            <span
              v-if="k.hasSteam"
              class="badge bg-app-surface2 text-brand"
            >{{ k.steam?.personaName || 'steam lié' }}</span>
            <span v-else class="badge bg-app-surface2 text-fg-muted">sans steam</span>

            <span class="text-[10px] text-fg-faint">{{ since(k.lastLoginAt) }}</span>

            <button
              v-if="!k.isAllowed && !k.isAdmin && !k.isMember"
              class="ml-2 text-xs text-brand hover:underline"
              @click="addKnown(k.discordId)"
            >
              Autoriser
            </button>
          </div>
        </li>
      </ul>
    </section>
  </div>
</template>
