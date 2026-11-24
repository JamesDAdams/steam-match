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
  hasSteam: boolean;
  steam: { steamid: string; personaName: string | null } | null;
}

const allowed = ref<Allowed[]>([]);
const known = ref<Known[]>([]);
const admins = ref<string[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const success = ref<string | null>(null);

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
    }>('/api/admin/users');
    allowed.value = data.allowed ?? [];
    known.value = data.known ?? [];
    admins.value = data.admins ?? [];
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
      <h1 class="text-2xl font-bold text-white">Administration</h1>
      <p class="mt-1 text-sm text-slate-400">
        Gère les comptes Discord autorisés à accéder au site.
      </p>
    </div>

    <!-- Alerte erreur / succès -->
    <div v-if="error" class="card mb-4 border-red-500/40 bg-red-500/5 text-sm text-red-300">
      {{ error }}
    </div>
    <div v-if="success" class="card mb-4 border-emerald-500/40 bg-emerald-500/5 text-sm text-emerald-300">
      {{ success }}
    </div>

    <!-- Ajout -->
    <section class="card mb-6">
      <h2 class="font-semibold text-white">Autoriser un ou plusieurs comptes</h2>
      <p class="mt-1 text-xs text-slate-500">
        Un ID Discord = 17 à 20 chiffres. Sur Discord : clic droit sur le pseudo →
        <em>Copier l'identifiant</em>. Tu peux coller plusieurs IDs séparés par
        des espaces ou des virgules.
      </p>

      <div class="mt-3 grid gap-3 sm:grid-cols-[1fr_auto]">
        <div class="space-y-2">
          <textarea
            v-model="input"
            rows="2"
            placeholder="123456789012345678"
            class="w-full rounded border border-white/15 bg-steam-darker px-3 py-2 font-mono text-sm text-slate-200 placeholder:text-slate-600 focus:border-steam-blue focus:outline-none"
          ></textarea>
          <input
            v-model="note"
            placeholder="Note (optionnel) — ex. pseudo Discord"
            class="w-full rounded border border-white/15 bg-steam-darker px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:border-steam-blue focus:outline-none"
          />
        </div>
        <button class="btn-primary h-fit text-sm" :disabled="saving || !input.trim()" @click="addIds">
          {{ saving ? 'Ajout…' : 'Autoriser' }}
        </button>
      </div>
    </section>

    <!-- Admins définis dans l'env -->
    <section class="card mb-6 border-amber-500/30 bg-amber-500/5">
      <h2 class="font-semibold text-amber-300">Administrateur(s)</h2>
      <p class="mt-1 text-xs text-slate-400">
        Défini(s) par la variable <code class="text-amber-300">DISCORD_ADMIN_ID</code>.
        Toujours autorisé(s), non modifiable(s) depuis cette page.
      </p>
      <div class="mt-2 flex flex-wrap gap-2">
        <code
          v-for="a in admins"
          :key="a"
          class="rounded border border-amber-500/30 bg-black/20 px-2 py-1 font-mono text-xs text-amber-200"
        >
          {{ a }}
        </code>
        <span v-if="admins.length === 0" class="text-xs text-red-300">
          Aucun admin configuré — renseigne DISCORD_ADMIN_ID.
        </span>
      </div>
    </section>

    <!-- Liste des autorisés -->
    <section class="card mb-6">
      <h2 class="font-semibold text-white">
        Autorisations actives
        <span class="ml-1 text-sm font-normal text-slate-500">({{ allowed.length }})</span>
      </h2>

      <div v-if="loading" class="mt-3 h-12 animate-pulse rounded bg-white/5"></div>
      <p v-else-if="allowed.length === 0" class="mt-3 text-sm text-slate-500">
        Aucun identifiant autorisé pour le moment. Les personnes qui tentent de se
        connecter apparaîtront ci-dessous avec leur ID.
      </p>
      <ul v-else class="mt-3 divide-y divide-white/10">
        <li
          v-for="a in allowed"
          :key="a.discordId"
          class="flex flex-wrap items-center gap-3 py-2"
        >
          <code class="font-mono text-sm text-slate-200">{{ a.discordId }}</code>
          <span v-if="a.note" class="text-xs text-slate-500">{{ a.note }}</span>
          <span v-if="knownIds.has(a.discordId) === false" class="badge bg-white/10 text-slate-400">
            jamais connecté
          </span>
          <button
            class="ml-auto text-xs text-red-400 hover:text-red-300 hover:underline"
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
        <h2 class="font-semibold text-white">Comptes déjà connectés</h2>
        <input
          v-model="search"
          placeholder="Rechercher…"
          class="ml-auto rounded border border-white/15 bg-steam-darker px-3 py-1.5 text-sm text-slate-200 placeholder:text-slate-600 focus:border-steam-blue focus:outline-none"
        />
      </div>

      <div v-if="loading" class="mt-3 h-20 animate-pulse rounded bg-white/5"></div>
      <p v-else-if="known.length === 0" class="mt-3 text-sm text-slate-500">
        Personne ne s'est encore connecté.
      </p>
      <ul v-else class="mt-3 divide-y divide-white/10">
        <li
          v-for="k in filteredKnown"
          :key="k.discordId"
          class="flex flex-wrap items-center gap-3 py-2"
        >
          <img
            v-if="k.avatarUrl"
            :src="k.avatarUrl"
            :alt="k.username"
            class="h-8 w-8 rounded-full border border-white/15"
          />
          <div v-else class="h-8 w-8 rounded-full border border-white/15 bg-steam-navy"></div>

          <div class="min-w-0">
            <p class="truncate text-sm text-slate-200">
              {{ k.globalName || k.username }}
              <span class="text-xs text-slate-500">@{{ k.username }}</span>
            </p>
            <p class="font-mono text-xs text-slate-500">{{ k.discordId }}</p>
          </div>

          <div class="ml-auto flex flex-wrap items-center gap-1">
            <span v-if="k.isAdmin" class="badge bg-amber-500/20 text-amber-300">admin</span>
            <span
              v-else-if="k.isAllowed"
              class="badge bg-emerald-500/20 text-emerald-300"
            >autorisé</span>
            <span v-else class="badge bg-red-500/20 text-red-300">refusé</span>

            <span
              v-if="k.hasSteam"
              class="badge bg-steam-navy/60 text-steam-blue"
            >{{ k.steam?.personaName || 'steam lié' }}</span>
            <span v-else class="badge bg-white/10 text-slate-400">sans steam</span>

            <span class="text-[10px] text-slate-600">{{ since(k.lastLoginAt) }}</span>

            <button
              v-if="!k.isAllowed && !k.isAdmin"
              class="ml-2 text-xs text-steam-blue hover:underline"
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
