<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { useAuth } from '../lib/auth';
import { apiPost } from '../lib/api';

const route = useRoute();
const { me, loading, refresh, canUseSite, hasSteam, displayName } = useAuth();

const syncing = ref(false);
const syncMsg = ref<{ ok: boolean; text: string } | null>(null);

// Page protégée demandée alors qu'on n'était pas connecté/autorise.
const fromPath = computed(() =>
  typeof route.query.from === 'string' ? route.query.from : null,
);

// Message d'erreur passé en query par les callbacks (Discord ou Steam).
const errorMsg = computed(() =>
  typeof route.query.error === 'string' ? route.query.error : null,
);

// Compte refusé : le callback nous a renvoyé son ID Discord à transmettre.
const denied = computed(() => route.query.denied === '1');
const deniedId = computed(() =>
  typeof route.query.id === 'string' ? route.query.id : '',
);
const deniedName = computed(() =>
  typeof route.query.name === 'string' ? route.query.name : '',
);

const copied = ref(false);

/** Page Steam des paramètres de confidentialité. */
const steamSettingsUrl = 'https://steamcommunity.com/my/edit/settings';

/**
 * Détection réelle de l'état de confidentialité Steam.
 *
 * Trois cas distincts, qu'il ne faut surtout pas confondre :
 *   - jamais synchronisé  → on ne sait RIEN, donc pas d'alerte (info neutre)
 *   - profil privé       → l'API ne renvoie même pas la ludothèque
 *   - détails masqués    → ludothèque renvoyée, mais temps de jeu à 0
 *
 * `gamesVisible` vaut false par défaut, y compris avant tout sync : c'est
 * précisément l'erreur à éviter que de l'afficher comme un problème.
 */
const steamAlert = computed(() => {
  const st = me.value.steam;
  if (!st) return null;

  // 1. Profil privé : connu dès la liaison Steam (GetPlayerSummaries).
  if (st.profileVisible === false) {
    return {
      level: 'error' as const,
      text:
        'Ton profil Steam est privé. Steam refuse alors de communiquer ta ' +
        'ludothèque au site : rien ne peut être comparé tant que tu ne passes ' +
        'pas ton profil en public. Aucun contournement n’existe, y compris ' +
        'via un groupe Steam.',
    };
  }

  // 2. Jamais synchronisé : on n'a aucune donnée, on ne prétend rien.
  if (!st.lastSyncAt) return null;

  // 3. Ludothèque visible mais temps de jeu à zéro : détails masqués.
  if (st.gamesVisible === false) {
    return {
      level: 'warning' as const,
      text:
        'Tes temps de jeu ne sont pas visibles. La ludothèque est bien ' +
        'récupérée, mais les recommandations resteront génériques sans les ' +
        'heures jouées. Active « Toujours afficher les détails du jeu ».',
    };
  }

  return null;
});

async function copyId() {
  try {
    await navigator.clipboard.writeText(deniedId.value);
    copied.value = true;
    setTimeout(() => (copied.value = false), 2000);
  } catch {
    copied.value = false;
  }
}

async function sync() {
  syncing.value = true;
  syncMsg.value = null;
  try {
    const r = await apiPost<any>('/api/sync');
    if (r.ok) {
      syncMsg.value = {
        ok: true,
        text: `${r.gamesCount} jeux synchronisés${
          r.playedCount ? ` — ${r.playedCount} avec temps de jeu` : ''
        }`,
      };
      await apiPost('/api/enrich').catch(() => {});
    } else {
      syncMsg.value = { ok: false, text: r.message ?? 'Synchronisation impossible.' };
    }
  } catch (e: any) {
    syncMsg.value = { ok: false, text: e.message };
  } finally {
    syncing.value = false;
  }
}

onMounted(refresh);
</script>

<template>
  <div class="mx-auto max-w-3xl">
    <!-- Écran 1 : compte Discord non autorisé -->
    <section v-if="denied" class="card border-red-500/40 bg-red-500/5">
      <h1 class="text-xl font-bold text-white">Accès non autorisé</h1>
      <p class="mt-2 text-sm text-slate-300">
        Ton compte Discord
        <strong v-if="deniedName">« {{ deniedName }} »</strong>
        ne figure pas dans la liste des personnes autorisées.
      </p>
      <p class="mt-3 text-sm text-slate-400">
        Transmets cet identifiant à l'administrateur pour qu'il t'ajoute :
      </p>
      <div class="mt-2 flex items-center gap-2">
        <code class="flex-1 rounded border border-white/15 bg-steam-darker px-3 py-2 font-mono text-sm text-steam-blue">
          {{ deniedId }}
        </code>
        <button class="btn-ghost text-xs" @click="copyId">
          {{ copied ? 'Copié !' : 'Copier' }}
        </button>
      </div>
      <a href="/api/auth/discord" class="btn-primary mt-4 text-sm">Réessayer la connexion</a>
    </section>

    <!-- Redirection depuis une page protégée -->
    <div
      v-if="fromPath && !canUseSite && !loading"
      class="card mb-4 border-sky-500/30 bg-sky-500/5 text-sm text-sky-200"
    >
      La page <code class="text-steam-blue">{{ fromPath }}</code> nécessite une
      connexion. Connecte-toi avec Discord pour continuer.
    </div>

    <!-- Écran 2 : erreur de callback -->
    <section v-else-if="errorMsg" class="card border-red-500/40 bg-red-500/5">
      <h1 class="text-xl font-bold text-white">Connexion impossible</h1>
      <p class="mt-2 text-sm text-red-200">{{ errorMsg }}</p>
      <a href="/api/auth/discord" class="btn-primary mt-4 text-sm">Recommencer</a>
    </section>

    <template v-else-if="!loading">
      <!-- Écran 3 : connecté et autorisé -->
      <section v-if="canUseSite" class="py-8">
        <h1 class="text-3xl font-bold text-white">
          Salut {{ displayName }} 👋
        </h1>

        <!-- Steam pas encore relié -->
        <div v-if="!hasSteam" class="card mt-6">
          <h2 class="font-semibold text-white">Dernière étape : relier Steam</h2>
          <p class="mt-2 text-sm text-slate-400">
            Ton compte Discord est validé. Il reste à autoriser la lecture de ta
            ludothèque Steam pour que le groupe puisse comparer ses jeux.
          </p>
          <p class="mt-2 text-sm text-slate-400">
            Steam te demandera de confirmer. Aucun mot de passe n'est transmis au
            site : c'est une authentification déléguée.
          </p>
          <a href="/api/auth/steam" class="btn-primary mt-4 text-sm">
            Relier mon compte Steam
          </a>
        </div>

        <!-- Steam relié -->
        <div v-else class="card mt-6">
          <div class="flex items-center gap-3">
            <div class="h-2 w-2 rounded-full bg-emerald-400"></div>
            <div>
              <p class="text-sm font-medium text-slate-200">
                Compte Steam relié : {{ me.steam?.personaName }}
              </p>
              <p class="text-xs text-slate-500">
                <template v-if="me.steam?.lastSyncAt">
                  Dernière synchronisation :
                  {{ new Date(me.steam.lastSyncAt).toLocaleString('fr-FR') }}
                </template>
                <template v-else>Jamais synchronisé</template>
              </p>
            </div>
          </div>

          <div class="mt-4 flex flex-wrap gap-2">
            <button class="btn-primary text-sm" :disabled="syncing" @click="sync">
              {{ syncing ? 'Synchronisation…' : 'Synchroniser ma ludothèque' }}
            </button>
            <router-link to="/commun" class="btn-ghost text-sm">
              Voir les jeux en commun
            </router-link>
          </div>

          <p
            v-if="syncMsg"
            class="mt-3 text-sm"
            :class="syncMsg.ok ? 'text-emerald-300' : 'text-red-300'"
          >
            {{ syncMsg.ok ? '✅' : '❌' }} {{ syncMsg.text }}
          </p>

          <!-- État de confidentialité Steam, détecté réellement -->
          <div
            v-if="steamAlert"
            class="mt-3 rounded border p-3"
            :class="
              steamAlert.level === 'error'
                ? 'border-red-500/40 bg-red-500/5'
                : 'border-amber-500/30 bg-amber-500/5'
            "
          >
            <p
              class="text-xs"
              :class="steamAlert.level === 'error' ? 'text-red-200' : 'text-amber-200'"
            >
              {{ steamAlert.text }}
            </p>

            <a
              :href="steamSettingsUrl"
              target="_blank"
              rel="noopener"
              class="btn-ghost mt-2 text-xs"
            >
              Ouvrir mes paramètres de confidentialité Steam
            </a>

            <p class="mt-2 text-[11px] text-slate-500">
              Nécessite d'être connecté à Steam dans ce navigateur. Une fois le
              réglage fait, reviens ici et clique sur « Synchroniser ».
            </p>
          </div>
        </div>

        <router-link
          v-if="canUseSite"
          to="/recommandations"
          class="mt-4 inline-block text-sm text-steam-blue hover:underline"
        >
          Voir les recommandations du groupe →
        </router-link>
      </section>

      <!-- Écran 4 : pas connecté -->
      <section v-else class="py-10 text-center">
        <h1 class="text-4xl font-bold tracking-tight text-white sm:text-5xl">
          Trouvez enfin le jeu
          <span class="text-steam-blue">qui plaît à tout le monde</span>
        </h1>
        <p class="mx-auto mt-4 max-w-xl text-slate-400">
          Chacun relie son compte Discord puis Steam. Vous voyez instantanément
          les jeux que vous avez en commun, filtrables par style — survie,
          aventure, stratégie… Et l'app propose le prochain jeu à lancer
          ensemble, à partir de vos temps de jeu réels.
        </p>

        <a href="/api/auth/discord" class="btn-primary mt-8 px-6 py-3 text-base">
          <svg class="h-5 w-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M20.32 4.37a19.8 19.8 0 0 0-4.89-1.52.07.07 0 0 0-.08.04c-.21.38-.44.87-.6 1.26a18.27 18.27 0 0 0-5.49 0 12.6 12.6 0 0 0-.61-1.26.08.08 0 0 0-.08-.04 19.74 19.74 0 0 0-4.88 1.52.07.07 0 0 0-.04.03C.53 9.05-.32 13.58.1 18.06a.08.08 0 0 0 .03.05 19.9 19.9 0 0 0 6 3.03.08.08 0 0 0 .08-.03c.46-.63.87-1.3 1.22-1.99a.08.08 0 0 0-.04-.11 13.1 13.1 0 0 1-1.87-.89.08.08 0 0 1-.01-.13c.13-.09.25-.19.37-.29a.07.07 0 0 1 .08-.01c3.93 1.79 8.18 1.79 12.06 0a.07.07 0 0 1 .08.01c.12.1.24.2.37.29a.08.08 0 0 1-.01.13c-.6.35-1.22.64-1.87.89a.08.08 0 0 0-.04.11c.36.7.77 1.36 1.22 1.99a.08.08 0 0 0 .08.03 19.84 19.84 0 0 0 6.01-3.03.08.08 0 0 0 .03-.05c.5-5.18-.84-9.68-3.54-13.66a.06.06 0 0 0-.03-.03ZM8.02 15.33c-1.18 0-2.15-1.08-2.15-2.42 0-1.33.95-2.42 2.15-2.42 1.21 0 2.17 1.1 2.15 2.42 0 1.34-.95 2.42-2.15 2.42Zm7.97 0c-1.18 0-2.15-1.08-2.15-2.42 0-1.33.95-2.42 2.15-2.42 1.21 0 2.17 1.1 2.15 2.42 0 1.34-.94 2.42-2.15 2.42Z" />
          </svg>
          Se connecter avec Discord
        </a>

        <p class="mt-3 text-xs text-slate-500">
          L'accès est restreint aux membres autorisés par l'administrateur.
        </p>

        <section class="mt-10 grid gap-4 text-left sm:grid-cols-3">
          <div class="card">
            <div class="mb-2 text-2xl">🔗</div>
            <h3 class="font-semibold text-white">1. Connecte-toi</h3>
            <p class="mt-1 text-sm text-slate-400">
              Discord pour l'identité, puis Steam pour la ludothèque.
            </p>
          </div>
          <div class="card">
            <div class="mb-2 text-2xl">🎮</div>
            <h3 class="font-semibold text-white">2. Comparez</h3>
            <p class="mt-1 text-sm text-slate-400">
              Voyez ce que vous possédez en commun, et filtrez par genre.
            </p>
          </div>
          <div class="card">
            <div class="mb-2 text-2xl">🧠</div>
            <h3 class="font-semibold text-white">3. Découvrez</h3>
            <p class="mt-1 text-sm text-slate-400">
              L'app analyse vos heures de jeu et propose des jeux pour le groupe.
            </p>
          </div>
        </section>
      </section>
    </template>
  </div>
</template>
