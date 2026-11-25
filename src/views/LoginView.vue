<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { useAuth } from '../lib/auth';
import { apiPost } from '../lib/api';

const route = useRoute();
const { me, loading, refresh, canUseSite, hasSteam, displayName } = useAuth();

const syncing = ref(false);
const syncMsg = ref<{ ok: boolean; text: string } | null>(null);

const fromPath = computed(() =>
  typeof route.query.from === 'string' ? route.query.from : null,
);
const errorMsg = computed(() =>
  typeof route.query.error === 'string' ? route.query.error : null,
);
const denied = computed(() => route.query.denied === '1');
const deniedId = computed(() =>
  typeof route.query.id === 'string' ? route.query.id : '',
);
const deniedName = computed(() =>
  typeof route.query.name === 'string' ? route.query.name : '',
);
/**
 * Motif du refus :
 *  - not_member  : le compte n'est pas sur le serveur Discord
 *  - unverified  : impossible de vérifier (bot absent ou Discord en panne)
 *  - sinon       : refus générique (ancien lien)
 */
const deniedReason = computed<'not_member' | 'unverified' | 'other'>(() => {
  const r = route.query.reason;
  if (r === 'not_member') return 'not_member';
  if (r === 'unverified') return 'unverified';
  return 'other';
});
const inviteUrl = computed(() => me.value.guildInviteUrl ?? null);

const copied = ref(false);

async function copyId() {
  try {
    await navigator.clipboard.writeText(deniedId.value);
    copied.value = true;
    setTimeout(() => (copied.value = false), 2000);
  } catch {
    copied.value = false;
  }
}

const steamSettingsUrl = 'https://steamcommunity.com/my/edit/settings';

/**
 * Détection réelle de la confidentialité Steam.
 * Trois cas distincts : jamais synchronisé / profil privé / détails masqués.
 * `gamesVisible` vaut false par défaut, y compris avant tout sync : il ne
 * faut donc pas l'afficher comme un problème.
 */
const steamAlert = computed(() => {
  const st = me.value.steam;
  if (!st) return null;

  if (st.profileVisible === false) {
    return {
      level: 'error' as const,
      text:
        'Ton profil Steam est privé : Steam refuse de communiquer ta ludothèque. ' +
        'Passe-le en public pour que le groupe puisse comparer ses jeux.',
    };
  }
  if (!st.lastSyncAt) return null;
  if (st.gamesVisible === false) {
    return {
      level: 'warning' as const,
      text:
        'Tes temps de jeu ne sont pas visibles. La ludothèque est récupérée, ' +
        'mais les recommandations resteront génériques sans les heures jouées.',
    };
  }
  return null;
});

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
    await refresh();
  }
}

onMounted(refresh);
</script>

<template>
  <div>
    <!-- ══════════ Accès refusé ══════════ -->
    <section v-if="denied" class="card mx-auto max-w-xl border-danger/40">
      <h1 class="font-display text-xl font-bold text-fg-strong">
        <template v-if="deniedReason === 'not_member'">Compte hors du serveur</template>
        <template v-else-if="deniedReason === 'unverified'">Vérification impossible</template>
        <template v-else>Accès non autorisé</template>
      </h1>

      <!-- Cas 1 : le compte n'est pas sur le serveur Discord -->
      <template v-if="deniedReason === 'not_member'">
        <p class="mt-2 text-sm text-fg">
          Le compte Discord
          <strong v-if="deniedName">« {{ deniedName }} »</strong>
          n'est pas membre du serveur Discord.
        </p>
        <p class="mt-2 text-sm text-fg-muted">
          L'accès au site est réservé aux membres du serveur. Rejoins-le, puis
          reconnecte-toi : ton accès sera validé automatiquement.
        </p>
        <div class="mt-4 flex flex-wrap gap-2">
          <a
            v-if="inviteUrl"
            :href="inviteUrl"
            target="_blank"
            rel="noopener"
            class="btn-primary text-sm"
          >
            Rejoindre le serveur Discord
          </a>
          <a href="/api/auth/discord" class="btn-ghost text-sm">
            J'ai rejoint — me reconnecter
          </a>
        </div>
      </template>

      <!-- Cas 2 : impossible de vérifier l'appartenance -->
      <template v-else-if="deniedReason === 'unverified'">
        <p class="mt-2 text-sm text-fg">
          Impossible de vérifier que ton compte fait partie du serveur Discord :
          le bot n'est pas configuré, ou Discord est momentanément injoignable.
        </p>
        <p class="mt-2 text-sm text-fg-muted">
          Réessaie dans un instant. Si le problème persiste, demande à un
          administrateur de t'autoriser manuellement.
        </p>
        <a href="/api/auth/discord" class="btn-primary mt-4 text-sm">Réessayer</a>
      </template>

      <!-- Cas 3 : refus générique -->
      <template v-else>
        <p class="mt-2 text-sm text-fg">
          Ton compte Discord
          <strong v-if="deniedName">« {{ deniedName }} »</strong>
          n'a pas accès au site.
        </p>
        <p class="mt-2 text-sm text-fg-muted">
          L'accès est réservé aux membres du serveur Discord. Si tu en fais
          partie, reconnecte-toi ; sinon, demande à un administrateur de
          t'autoriser.
        </p>
        <a href="/api/auth/discord" class="btn-primary mt-4 text-sm">Réessayer</a>
      </template>

      <!-- Autorisation manuelle : toujours possible, quel que soit le motif -->
      <div class="mt-5 rounded-lg border border-line bg-app-elevated p-3">
        <p class="text-xs text-fg-muted">
          Un administrateur peut t'autoriser manuellement. Transmets-lui cet
          identifiant Discord :
        </p>
        <div class="mt-2 flex items-center gap-2">
          <code class="flex-1 rounded border border-line bg-app-bg px-3 py-2 font-mono text-sm text-brand">
            {{ deniedId }}
          </code>
          <button class="btn-ghost text-xs" @click="copyId">
            {{ copied ? 'Copié !' : 'Copier' }}
          </button>
        </div>
      </div>
    </section>

    <!-- ══════════ Erreur de connexion ══════════ -->
    <section v-else-if="errorMsg" class="card mx-auto max-w-xl border-danger/40">
      <h1 class="font-display text-xl font-bold text-fg-strong">Connexion impossible</h1>
      <p class="mt-2 text-sm text-danger">{{ errorMsg }}</p>
      <a href="/api/auth/discord" class="btn-primary mt-4 text-sm">Recommencer</a>
    </section>

    <template v-else-if="!loading">
      <!-- ══════════ Espace membre ══════════ -->
      <section v-if="canUseSite">
        <div class="mb-6">
          <p class="text-xs uppercase tracking-[0.18em] text-fg-faint">Espace membre</p>
          <h1 class="mt-1 font-display text-3xl font-bold text-fg-strong">
            Salut {{ displayName }} 👋
          </h1>
        </div>

        <!-- Redirection depuis une page protégée -->
        <div v-if="fromPath" class="alert alert-info mb-4">
          La page <code class="text-brand">{{ fromPath }}</code> nécessite une connexion.
        </div>

        <!-- Steam non relié -->
        <div v-if="!hasSteam" class="card">
          <h2 class="font-display text-lg font-semibold text-fg-strong">
            Dernière étape : relier Steam
          </h2>
          <p class="mt-2 text-sm text-fg-muted">
            Ton compte Discord est validé. Il reste à autoriser la lecture de ta
            ludothèque pour que le groupe puisse comparer ses jeux.
          </p>
          <a href="/api/auth/steam" class="btn-primary mt-4 text-sm">
            Relier mon compte Steam
          </a>
        </div>

        <!-- Steam relié -->
        <div v-else class="card">
          <div class="flex flex-wrap items-center gap-3">
            <span class="inline-block h-2 w-2 rounded-full bg-ok"></span>
            <p class="text-sm text-fg">
              Compte Steam relié :
              <strong class="text-fg-strong">{{ me.steam?.personaName }}</strong>
            </p>
            <span class="text-xs text-fg-faint">
              <template v-if="me.steam?.lastSyncAt">
                synchronisé le {{ new Date(me.steam.lastSyncAt).toLocaleString('fr-FR') }}
              </template>
              <template v-else>jamais synchronisé</template>
            </span>
          </div>

          <div class="mt-4 flex flex-wrap gap-2">
            <button class="btn-primary text-sm" :disabled="syncing" @click="sync">
              {{ syncing ? 'Synchronisation…' : 'Synchroniser ma ludothèque' }}
            </button>
            <router-link to="/evenements" class="btn-ghost text-sm">Voir les événements</router-link>
            <router-link to="/commun" class="btn-ghost text-sm">Jeux en commun</router-link>
          </div>

          <p v-if="syncMsg" class="mt-3 text-sm" :class="syncMsg.ok ? 'text-ok' : 'text-danger'">
            {{ syncMsg.ok ? '✓' : '✕' }} {{ syncMsg.text }}
          </p>

          <div v-if="steamAlert" class="alert mt-3" :class="steamAlert.level === 'error' ? 'alert-error' : 'alert-warn'">
            <p class="text-xs">{{ steamAlert.text }}</p>
            <a :href="steamSettingsUrl" target="_blank" rel="noopener" class="btn-ghost mt-2 text-xs">
              Ouvrir mes paramètres Steam
            </a>
          </div>
        </div>

        <!-- Accès rapides -->
        <div class="mt-6 grid gap-4 sm:grid-cols-3">
          <router-link to="/evenements" class="card-flat group transition hover:border-brand/50">
            <div class="mb-2 text-2xl">📅</div>
            <h3 class="font-display font-semibold text-fg-strong">Événements</h3>
            <p class="mt-1 text-sm text-fg-muted">Les rendez-vous du serveur Discord.</p>
          </router-link>
          <router-link to="/commun" class="card-flat group transition hover:border-brand/50">
            <div class="mb-2 text-2xl">🎮</div>
            <h3 class="font-display font-semibold text-fg-strong">Jeux en commun</h3>
            <p class="mt-1 text-sm text-fg-muted">Ce que vous possédez, par style.</p>
          </router-link>
          <router-link to="/recommandations" class="card-flat group transition hover:border-brand/50">
            <div class="mb-2 text-2xl">✨</div>
            <h3 class="font-display font-semibold text-fg-strong">Recommandations</h3>
            <p class="mt-1 text-sm text-fg-muted">Le jeu qui plaira à tout le monde.</p>
          </router-link>
        </div>
      </section>

      <!-- ══════════ Page publique ══════════ -->
      <section v-else>
        <!-- Connecté mais accès révoqué : membership perdue depuis la connexion -->
        <div v-if="me.authenticated" class="alert alert-warn mb-6">
          <p class="font-semibold">Accès suspendu</p>
          <p class="mt-1 text-xs">
            <template v-if="me.accessReason === 'NOT_MEMBER'">
              Ton compte Discord n'est plus membre du serveur, l'accès au site
              est donc fermé. Rejoins le serveur (ou demande une autorisation à
              un administrateur), puis reconnecte-toi.
            </template>
            <template v-else>
              L'appartenance au serveur n'a pas pu être vérifiée (bot Discord
              indisponible). Réessaie dans un instant, ou demande à un
              administrateur de t'autoriser.
            </template>
          </p>
          <div class="mt-3 flex flex-wrap gap-2">
            <a
              v-if="inviteUrl"
              :href="inviteUrl"
              target="_blank"
              rel="noopener"
              class="btn-ghost text-xs"
            >
              Rejoindre le serveur
            </a>
            <a href="/api/auth/discord" class="btn-primary text-xs">Se reconnecter</a>
          </div>
        </div>

        <!-- Hero -->
        <div class="hero-glow relative -mx-4 px-4 pb-16 pt-12 text-center sm:pt-20">
          <span class="chip mx-auto mb-5 !border-gold/40 !text-gold">
            <span class="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-ok"></span>
            Communauté multigaming
          </span>

          <h1 class="mx-auto max-w-3xl font-display text-4xl font-bold leading-tight text-fg-strong sm:text-6xl">
            Unis par le jeu,
            <span class="bg-gradient-to-r from-brand to-gold bg-clip-text text-transparent">
              pas par le hasard
            </span>
          </h1>

          <p class="mx-auto mt-5 max-w-2xl text-base text-fg-muted sm:text-lg">
            On rassemble nos ludothèques Steam pour trouver les jeux qu'on a
            vraiment en commun — et surtout celui auquel on va jouer ensemble
            ce soir.
          </p>

          <div class="mt-8 flex flex-wrap items-center justify-center gap-3">
            <a href="/api/auth/discord" class="btn-primary px-6 py-3 text-base">
              <svg class="h-5 w-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M20.32 4.37a19.8 19.8 0 0 0-4.89-1.52.07.07 0 0 0-.08.04c-.21.38-.44.87-.6 1.26a18.27 18.27 0 0 0-5.49 0 12.6 12.6 0 0 0-.61-1.26.08.08 0 0 0-.08-.04 19.74 19.74 0 0 0-4.88 1.52.07.07 0 0 0-.04.03C.53 9.05-.32 13.58.1 18.06a.08.08 0 0 0 .03.05 19.9 19.9 0 0 0 6 3.03.08.08 0 0 0 .08-.03c.46-.63.87-1.3 1.22-1.99a.08.08 0 0 0-.04-.11 13.1 13.1 0 0 1-1.87-.89.08.08 0 0 1-.01-.13c.13-.09.25-.19.37-.29a.07.07 0 0 1 .08-.01c3.93 1.79 8.18 1.79 12.06 0a.07.07 0 0 1 .08.01c.12.1.24.2.37.29a.08.08 0 0 1-.01.13c-.6.35-1.22.64-1.87.89a.08.08 0 0 0-.04.11c.36.7.77 1.36 1.22 1.99a.08.08 0 0 0 .08.03 19.84 19.84 0 0 0 6.01-3.03.08.08 0 0 0 .03-.05c.5-5.18-.84-9.68-3.54-13.66a.06.06 0 0 0-.03-.03ZM8.02 15.33c-1.18 0-2.15-1.08-2.15-2.42 0-1.33.95-2.42 2.15-2.42 1.21 0 2.17 1.1 2.15 2.42 0 1.34-.95 2.42-2.15 2.42Zm7.97 0c-1.18 0-2.15-1.08-2.15-2.42 0-1.33.95-2.42 2.15-2.42 1.21 0 2.17 1.1 2.15 2.42 0 1.34-.94 2.42-2.15 2.42Z" />
              </svg>
              Rejoindre avec Discord
            </a>
            <a href="#comment" class="btn-ghost px-6 py-3 text-base">Comment ça marche</a>
          </div>

          <p class="mt-4 text-xs text-fg-faint">
            Accès réservé aux membres autorisés · aucun mot de passe stocké
          </p>
        </div>

        <!-- Piliers -->
        <div class="grid gap-4 sm:grid-cols-3">
          <div class="card-flat">
            <div class="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-brand-soft text-xl">📅</div>
            <h3 class="font-display text-lg font-semibold text-fg-strong">Événements</h3>
            <p class="mt-1.5 text-sm text-fg-muted">
              Les rendez-vous du serveur Discord remontent sur le site
              automatiquement : soirées jeu, tournois, sessions détente.
            </p>
          </div>
          <div class="card-flat">
            <div class="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-brand-soft text-xl">🎮</div>
            <h3 class="font-display text-lg font-semibold text-fg-strong">Jeux en commun</h3>
            <p class="mt-1.5 text-sm text-fg-muted">
              On croise les ludothèques Steam : ce que tout le monde possède,
              filtrable par genre — survie, aventure, co-op.
            </p>
          </div>
          <div class="card-flat">
            <div class="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-brand-soft text-xl">✨</div>
            <h3 class="font-display text-lg font-semibold text-fg-strong">Découvertes</h3>
            <p class="mt-1.5 text-sm text-fg-muted">
              Nos heures de jeu dessinent nos goûts. L'algo propose le jeu qui
              plaît au groupe, et croise les wishlists.
            </p>
          </div>
        </div>

        <!-- Comment ça marche -->
        <section id="comment" class="mt-16">
          <h2 class="text-center font-display text-2xl font-bold text-fg-strong">
            Comment ça marche
          </h2>
          <div class="mt-8 grid gap-6 sm:grid-cols-3">
            <div class="text-center">
              <div class="mx-auto flex h-12 w-12 items-center justify-center rounded-full border border-line bg-app-surface font-display text-lg font-bold text-gold">
                1
              </div>
              <h3 class="mt-3 font-semibold text-fg-strong">Connexion Discord</h3>
              <p class="mt-1 text-sm text-fg-muted">
                Ton compte Discord fait foi. L'accès est validé par un
                administrateur du serveur.
              </p>
            </div>
            <div class="text-center">
              <div class="mx-auto flex h-12 w-12 items-center justify-center rounded-full border border-line bg-app-surface font-display text-lg font-bold text-gold">
                2
              </div>
              <h3 class="mt-3 font-semibold text-fg-strong">Liaison Steam</h3>
              <p class="mt-1 text-sm text-fg-muted">
                Tu autorises la lecture de ta ludothèque et de tes temps de jeu.
                Rien d'autre n'est touché.
              </p>
            </div>
            <div class="text-center">
              <div class="mx-auto flex h-12 w-12 items-center justify-center rounded-full border border-line bg-app-surface font-display text-lg font-bold text-gold">
                3
              </div>
              <h3 class="mt-3 font-semibold text-fg-strong">On joue</h3>
              <p class="mt-1 text-sm text-fg-muted">
                Les jeux en commun apparaissent, les recommandations aussi, et
                les événements sont sur la page dédiée.
              </p>
            </div>
          </div>
        </section>

        <!-- Bandeau Discord -->
        <section class="mt-16 overflow-hidden rounded-2xl border border-line bg-app-surface p-8 text-center">
          <h2 class="font-display text-2xl font-bold text-fg-strong">
            La communauté vit sur Discord
          </h2>
          <p class="mx-auto mt-2 max-w-lg text-sm text-fg-muted">
            Les événements sont créés là-bas et remontent ici. Rejoins le serveur,
            puis connecte-toi pour accéder à ton espace.
          </p>
          <a href="/api/auth/discord" class="btn-gold mt-5 px-6 py-3">
            Se connecter avec Discord
          </a>
        </section>
      </section>
    </template>
  </div>
</template>
