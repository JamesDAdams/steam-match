<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { apiGet, formatPlaytime } from '../lib/api';

/**
 * Annuaire des membres du serveur Discord.
 *
 * La liste vient du serveur lui-même (via le bot), donc un membre qui n'a
 * jamais ouvert le site y figure quand même — avec la mention « profil pas
 * encore créé ».
 */
interface Member {
  discordId: string;
  name: string;
  avatarUrl: string | null;
  isAdmin: boolean;
  joinedAt: string | null;
  hasAccount: boolean;
  steam: { steamid: string; personaName: string; avatarUrl: string | null } | null;
  gamesCount: number;
  totalMinutes: number;
}

const loading = ref(true);
const error = ref<string | null>(null);
const members = ref<Member[]>([]);
const withSteam = ref(0);
const search = ref('');

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return members.value;
  return members.value.filter(
    (m) =>
      m.name.toLowerCase().includes(q) ||
      (m.steam?.personaName ?? '').toLowerCase().includes(q),
  );
});

async function load() {
  loading.value = true;
  try {
    const r = await apiGet<{ members: Member[]; withSteam: number }>('/api/members');
    members.value = r.members ?? [];
    withSteam.value = r.withSteam ?? 0;
    error.value = null;
  } catch (e: any) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div>
    <div class="mb-6 flex flex-wrap items-end gap-3">
      <div>
        <h1 class="font-display text-3xl font-bold text-fg-strong">Membres</h1>
        <p class="mt-1 text-sm text-fg-muted">
          {{ members.length }} membre{{ members.length > 1 ? 's' : '' }} du serveur ·
          {{ withSteam }} avec une ludothèque reliée
        </p>
      </div>
      <div class="ml-auto">
        <input
          v-model="search"
          type="text"
          class="input w-64"
          placeholder="Rechercher un membre…"
        />
      </div>
    </div>

    <div v-if="error" class="card mb-4 border-danger bg-danger-soft text-sm text-danger">
      {{ error }}
    </div>

    <div v-if="loading" class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <div v-for="i in 6" :key="i" class="h-24 animate-pulse rounded-lg bg-app-surface2"></div>
    </div>

    <div v-else-if="filtered.length" class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <router-link
        v-for="m in filtered"
        :key="m.discordId"
        :to="`/membres/${m.discordId}`"
        class="card flex items-center gap-3 p-3 transition hover:border-brand/50"
      >
        <img
          v-if="m.avatarUrl"
          :src="m.avatarUrl"
          :alt="m.name"
          class="h-12 w-12 shrink-0 rounded-full object-cover"
          loading="lazy"
        />
        <div
          v-else
          class="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-app-surface2 text-sm font-semibold text-fg-muted"
        >
          {{ m.name.charAt(0).toUpperCase() }}
        </div>

        <div class="min-w-0 flex-1">
          <p class="flex items-center gap-2 truncate text-sm font-medium text-fg-strong">
            <span class="truncate">{{ m.name }}</span>
            <span v-if="m.isAdmin" class="badge bg-gold-soft text-gold">admin</span>
          </p>
          <p v-if="m.steam" class="truncate text-[11px] text-fg-faint">
            Steam : {{ m.steam.personaName }}
          </p>
          <p v-else class="text-[11px] text-fg-faint">Compte Steam non relié</p>
          <p v-if="m.steam" class="mt-0.5 text-[11px] text-fg-muted">
            {{ m.gamesCount }} jeu{{ m.gamesCount > 1 ? 'x' : '' }} ·
            {{ formatPlaytime(m.totalMinutes) }}
          </p>
        </div>
      </router-link>
    </div>

    <div v-else class="card py-10 text-center text-fg-muted">
      Aucun membre ne correspond à cette recherche.
    </div>
  </div>
</template>
