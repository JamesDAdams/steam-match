<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { apiGet, apiPost, steamStoreUrl } from '../lib/api';

interface MemberScore {
  steamid: string;
  personaName: string;
  score: number;
  owned: boolean;
}

interface Reco {
  appid: number;
  name: string;
  headerImage: string | null;
  genres: string[];
  tags: string[];
  score: number;
  minScore: number;
  perMember: MemberScore[];
  owners: number;
}

const recos = ref<Reco[]>([]);
const meta = ref<any>(null);
const message = ref<string | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);
const limit = ref(20);

// Partiellement possédé = au moins un membre l'a déjà → plus facile à lancer.
const onlyPartiallyOwned = ref(false);

const filtered = computed(() => {
  if (!onlyPartiallyOwned.value) return recos.value;
  return recos.value.filter((r) => r.owners > 0);
});

function pct(score: number, max: number) {
  if (!max) return 0;
  return Math.max(0, Math.min(100, Math.round((score / max) * 100)));
}

const maxScore = computed(() =>
  recos.value.length ? Math.max(...recos.value.map((r) => r.minScore)) : 0,
);

async function load() {
  loading.value = true;
  error.value = null;
  message.value = null;
  try {
    const data = await apiGet<{
      ok: boolean;
      recommendations: Reco[];
      meta: any;
      message?: string;
    }>('/api/recommendations', { limit: limit.value });
    recos.value = data.recommendations ?? [];
    meta.value = data.meta ?? null;
    message.value = data.message ?? null;
  } catch (e: any) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

async function runSync() {
  await apiPost('/api/sync').catch(() => {});
  await apiPost('/api/enrich').catch(() => {});
  await load();
}

onMounted(load);
</script>

<template>
  <div>
    <div class="mb-6">
      <h1 class="text-2xl font-bold text-white">Recommandations pour le groupe</h1>
      <p class="mt-1 text-sm text-slate-400">
        Basées sur vos heures de jeu réelles — pas sur des notes.
      </p>
    </div>

    <!-- Explication de l'algo -->
    <div class="card mb-6">
      <h2 class="font-semibold text-white">Comment c'est calculé</h2>
      <ol class="mt-3 space-y-2 text-sm text-slate-400">
        <li>
          <span class="text-steam-blue">1.</span> Pour chacun, on construit un
          profil d'affinité par style (survie, stratégie, co-op…), pondéré par le
          <strong class="text-slate-200">temps de jeu</strong> — avec une
          pondération logarithmique, pour qu'un jeu à 2000 h n'écrase pas tout
          le reste.
        </li>
        <li>
          <span class="text-steam-blue">2.</span> Pour chaque jeu candidat, on
          calcule le score de chaque membre, puis on retient le
          <strong class="text-slate-200">score minimum</strong>. C'est ce qui
          garantit « plaît à tout le monde » plutôt qu'à un seul.
        </li>
        <li>
          <span class="text-steam-blue">3.</span> On propose les jeux qui
          maximisent ce minimum, avec un léger bonus pour ceux que certains
          possèdent déjà.
        </li>
      </ol>
    </div>

    <!-- Avertissement signal faible -->
    <div v-if="meta?.weakSignal" class="card mb-6 border-amber-500/30 bg-amber-500/5">
      <p class="text-sm text-amber-300">
        ⚠️ Signal faible : {{ meta.membersWithPlaytime }} / {{ meta.members }}
        membres exposent leurs temps de jeu.
      </p>
      <p class="mt-2 text-sm text-slate-400">
        Sans temps de jeu, on ne peut deviner que grossièrement les goûts — les
        propositions resteront génériques. Active
        <em>« Toujours afficher les détails du jeu »</em> sur Steam puis
        resynchronise (voir <router-link to="/aide" class="text-steam-blue hover:underline">l'aide</router-link>).
      </p>
    </div>

    <!-- Besoin d'enrichissement -->
    <div v-if="message && !error" class="card mb-6 border-sky-500/30 bg-sky-500/5">
      <p class="text-sm text-sky-300">{{ message }}</p>
      <button class="btn-primary mt-3 text-sm" @click="runSync">Synchroniser et enrichir</button>
    </div>

    <div v-if="error" class="card mb-6 border-red-500/40 bg-red-500/5 text-sm text-red-300">
      {{ error }}
    </div>

    <!-- Contrôles -->
    <div class="mb-4 flex flex-wrap items-center gap-4">
      <label class="flex items-center gap-2 text-sm text-slate-300">
        <input v-model="onlyPartiallyOwned" type="checkbox" class="rounded border-white/20 bg-steam-darker" />
        Seulement les jeux qu'au moins un membre possède déjà
      </label>
      <div class="ml-auto flex items-center gap-2 text-sm">
        <label class="text-slate-400">Nombre</label>
        <select v-model.number="limit" class="rounded border border-white/15 bg-steam-darker px-2 py-1 text-slate-200" @change="load">
          <option :value="10">10</option>
          <option :value="20">20</option>
          <option :value="50">50</option>
        </select>
      </div>
    </div>

    <!-- Résultats -->
    <div v-if="loading" class="space-y-4">
      <div v-for="i in 5" :key="i" class="h-32 animate-pulse rounded-lg bg-white/5"></div>
    </div>

    <div v-else-if="filtered.length === 0" class="card py-12 text-center text-slate-400">
      Pas encore assez de données. Synchronise les ludothèques puis réessaie.
    </div>

    <div v-else class="space-y-4">
      <article
        v-for="(r, idx) in filtered"
        :key="r.appid"
        class="card flex gap-4 p-0"
      >
        <a :href="steamStoreUrl(r.appid)" target="_blank" rel="noopener" class="flex w-56 shrink-0 items-center overflow-hidden rounded-l-lg bg-steam-navy/40">
          <img v-if="r.headerImage" :src="r.headerImage" :alt="r.name" loading="lazy" class="h-full w-full object-cover" />
          <span v-else class="p-4 text-xs text-slate-600">{{ r.name }}</span>
        </a>

        <div class="flex min-w-0 flex-1 flex-col p-4">
          <div class="flex items-start gap-2">
            <span class="badge bg-steam-navy text-steam-blue">#{{ idx + 1 }}</span>
            <h3 class="truncate font-semibold text-white">{{ r.name }}</h3>
          </div>

          <div v-if="r.genres.length" class="mt-2 flex flex-wrap gap-1">
            <span v-for="g in r.genres.slice(0, 4)" :key="g" class="badge bg-steam-navy/60 text-steam-blue">{{ g }}</span>
            <span v-for="t in r.tags.slice(0, 3)" :key="t" class="badge bg-white/5 text-slate-400">{{ t }}</span>
          </div>

          <!-- Score par membre -->
          <div class="mt-3 space-y-1.5">
            <div v-for="m in r.perMember" :key="m.steamid" class="flex items-center gap-2 text-xs">
              <span class="w-28 shrink-0 truncate text-slate-400" :title="m.personaName">
                {{ m.personaName }}
              </span>
              <div class="h-1.5 flex-1 overflow-hidden rounded bg-white/10">
                <div
                  class="h-full rounded transition-all"
                  :class="m.owned ? 'bg-emerald-400/80' : 'bg-steam-blue/80'"
                  :style="{ width: pct(m.score, maxScore) + '%' }"
                ></div>
              </div>
              <span class="w-14 shrink-0 text-right text-slate-500">
                {{ m.owned ? 'possédé' : 'à acheter' }}
              </span>
            </div>
          </div>

          <p class="mt-2 text-xs text-slate-500">
            Score groupe (minimum) : {{ r.minScore.toFixed(3) }} — possédé par {{ r.owners }} membre{{ r.owners > 1 ? 's' : '' }}
          </p>
        </div>
      </article>
    </div>

    <p v-if="meta" class="mt-6 text-center text-xs text-slate-600">
      Catalogue enrichi : {{ meta.enrichedGames }} jeux — {{ meta.candidates ?? meta.candidateCount }} candidats évalués
    </p>
  </div>
</template>
