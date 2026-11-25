<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { useRoute } from 'vue-router';
import { apiPost } from './lib/api';
import { useAuth } from './lib/auth';
import { useTheme } from './lib/theme';

const { me, loading, refresh, canUseSite, displayName } = useAuth();
const { theme, init: initTheme, toggle: toggleTheme } = useTheme();
const route = useRoute();

const menuOpen = ref(false);

onMounted(() => {
  initTheme();
  refresh();
});

const avatar = computed(() => me.value.discord?.avatarUrl ?? null);
const initial = computed(() => displayName.value.slice(0, 1).toUpperCase());

async function logout() {
  await apiPost('/api/me').catch(() => {});
  me.value = { authenticated: false };
  location.href = '/';
}

// Ferme le menu mobile à chaque navigation.
/**
 * Événements et Twitch sont PUBLICS : visibles avant même la connexion, pour
 * donner envie de rejoindre. Le reste demande l'accès au site.
 */
const links = computed(() => [
  { to: '/evenements', label: 'Événements' },
  ...(canUseSite.value
    ? [
        { to: '/commun', label: 'Jeux en commun' },
        { to: '/membres', label: 'Membres' },
        { to: '/recommandations', label: 'Recommandations' },
      ]
    : []),
  { to: '/twitch', label: 'Twitch' },
  ...(canUseSite.value ? [{ to: '/aide', label: 'Aide' }] : []),
]);
</script>

<template>
  <div class="flex min-h-screen flex-col">
    <header
      class="sticky top-0 z-40 border-b border-line bg-app-bg/90 backdrop-blur-md"
    >
      <div class="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4">
        <!-- Logo : une seule ligne, sous-titre retiré pour gagner en hauteur -->
        <router-link
          to="/"
          class="flex shrink-0 items-center gap-2.5 whitespace-nowrap"
          aria-label="Le Bastion des Gamers — accueil"
        >
          <img
            src="/logo-mark-192.webp"
            alt=""
            width="32"
            height="32"
            class="h-8 w-8 shrink-0 rounded-lg object-cover ring-1 ring-line-strong"
          />
          <span class="font-display text-[15px] font-bold leading-none tracking-tight text-fg-strong">
            Le Bastion <span class="text-gold">des Gamers</span>
          </span>
        </router-link>

        <!-- Navigation bureau : alignée, libellés sur une ligne -->
        <nav class="hidden items-center gap-1 lg:flex">
          <router-link
            v-for="l in links"
            :key="l.to"
            :to="l.to"
            class="whitespace-nowrap rounded-md px-2.5 py-1.5 text-[13px] text-fg-muted transition hover:bg-app-surface2 hover:text-fg-strong"
            active-class="!bg-brand-soft !text-fg-strong"
          >
            {{ l.label }}
          </router-link>
          <router-link
            v-if="me.isAdmin"
            to="/admin"
            class="whitespace-nowrap rounded-md px-2.5 py-1.5 text-[13px] font-medium text-gold transition hover:bg-gold-soft"
            active-class="!bg-gold-soft"
          >
            Admin
          </router-link>
        </nav>

        <!-- Actions à droite -->
        <div class="ml-auto flex shrink-0 items-center gap-2">
          <!-- Bascule de thème -->
          <button
            class="flex h-8 w-8 items-center justify-center rounded-md border border-line text-fg-muted transition hover:border-line-strong hover:text-fg-strong"
            :title="theme === 'dark' ? 'Thème clair' : 'Thème sombre'"
            :aria-label="theme === 'dark' ? 'Activer le thème clair' : 'Activer le thème sombre'"
            @click="toggleTheme"
          >
            <svg v-if="theme === 'dark'" class="h-[15px] w-[15px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" />
            </svg>
            <svg v-else class="h-[15px] w-[15px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
            </svg>
          </button>

          <span class="h-5 w-px bg-line"></span>

          <template v-if="loading">
            <div class="h-8 w-8 animate-pulse rounded-full bg-app-surface2"></div>
          </template>

          <template v-else-if="me.authenticated">
            <router-link
              to="/profil"
              class="flex items-center gap-2 rounded-md px-1 py-1 transition hover:bg-app-surface2"
              title="Mon profil"
            >
              <img
                v-if="avatar"
                :src="avatar"
                :alt="displayName"
                class="h-7 w-7 rounded-full border border-line-strong"
              />
              <span
                v-else
                class="flex h-7 w-7 items-center justify-center rounded-full bg-brand text-[11px] font-bold text-white"
              >
                {{ initial }}
              </span>
              <span class="hidden whitespace-nowrap text-[13px] text-fg sm:inline">
                {{ displayName }}
              </span>
            </router-link>

            <button
              class="flex h-8 w-8 items-center justify-center rounded-md border border-line text-fg-muted transition hover:border-danger hover:text-danger"
              title="Déconnexion"
              aria-label="Déconnexion"
              @click="logout"
            >
              <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
              </svg>
            </button>
          </template>

          <template v-else>
            <a href="/api/auth/discord" class="btn-primary !py-1.5 !text-[13px]">
              <svg class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M20.32 4.37a19.8 19.8 0 0 0-4.89-1.52.07.07 0 0 0-.08.04c-.21.38-.44.87-.6 1.26a18.27 18.27 0 0 0-5.49 0 12.6 12.6 0 0 0-.61-1.26.08.08 0 0 0-.08-.04 19.74 19.74 0 0 0-4.88 1.52.07.07 0 0 0-.04.03C.53 9.05-.32 13.58.1 18.06a.08.08 0 0 0 .03.05 19.9 19.9 0 0 0 6 3.03.08.08 0 0 0 .08-.03c.46-.63.87-1.3 1.22-1.99a.08.08 0 0 0-.04-.11 13.1 13.1 0 0 1-1.87-.89.08.08 0 0 1-.01-.13c.13-.09.25-.19.37-.29a.07.07 0 0 1 .08-.01c3.93 1.79 8.18 1.79 12.06 0a.07.07 0 0 1 .08.01c.12.1.24.2.37.29a.08.08 0 0 1-.01.13c-.6.35-1.22.64-1.87.89a.08.08 0 0 0-.04.11c.36.7.77 1.36 1.22 1.99a.08.08 0 0 0 .08.03 19.84 19.84 0 0 0 6.01-3.03.08.08 0 0 0 .03-.05c.5-5.18-.84-9.68-3.54-13.66a.06.06 0 0 0-.03-.03ZM8.02 15.33c-1.18 0-2.15-1.08-2.15-2.42 0-1.33.95-2.42 2.15-2.42 1.21 0 2.17 1.1 2.15 2.42 0 1.34-.95 2.42-2.15 2.42Zm7.97 0c-1.18 0-2.15-1.08-2.15-2.42 0-1.33.95-2.42 2.15-2.42 1.21 0 2.17 1.1 2.15 2.42 0 1.34-.94 2.42-2.15 2.42Z" />
              </svg>
              Connexion
            </a>
          </template>

          <!-- Menu mobile (nav masquée sous lg pour éviter le wrap) -->
          <button
            class="flex h-8 w-8 items-center justify-center rounded-md border border-line text-fg-muted lg:hidden"
            aria-label="Ouvrir le menu"
            @click="menuOpen = !menuOpen"
          >
            <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
        </div>
      </div>

      <!-- Navigation mobile -->
      <nav v-if="menuOpen" class="border-t border-line px-3 py-2 lg:hidden">
        <router-link
          v-for="l in links"
          :key="l.to"
          :to="l.to"
          class="block rounded-md px-3 py-2 text-sm text-fg-muted hover:bg-app-surface2 hover:text-fg-strong"
          active-class="!bg-brand-soft !text-fg-strong"
          @click="menuOpen = false"
        >
          {{ l.label }}
        </router-link>
        <router-link
          v-if="me.isAdmin"
          to="/admin"
          class="block rounded-md px-3 py-2 text-sm text-gold hover:bg-gold-soft"
          @click="menuOpen = false"
        >
          Admin
        </router-link>
      </nav>
    </header>

    <main class="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
      <router-view />
    </main>

    <footer class="mt-16 border-t border-line bg-app-elevated">
      <div class="mx-auto max-w-6xl px-4 py-8">
        <div class="flex flex-wrap items-start justify-between gap-6">
          <div>
            <p class="font-display text-sm font-bold text-fg-strong">
              Le Bastion <span class="text-gold">des Gamers</span>
            </p>
            <p class="mt-1 max-w-xs text-xs text-fg-muted">
              Association gaming — on rassemble les ludothèques pour trouver le
              jeu qui plaît à tout le monde.
            </p>
          </div>
          <div class="flex flex-wrap gap-8 text-xs text-fg-muted">
            <div class="space-y-1">
              <p class="mb-2 font-semibold uppercase tracking-wide text-fg-faint">Navigation</p>
              <router-link to="/evenements" class="block hover:text-fg-strong">Événements</router-link>
              <router-link v-if="canUseSite" to="/commun" class="block hover:text-fg-strong">Jeux en commun</router-link>
              <router-link v-if="canUseSite" to="/membres" class="block hover:text-fg-strong">Membres</router-link>
              <router-link v-if="canUseSite" to="/recommandations" class="block hover:text-fg-strong">Recommandations</router-link>
              <router-link to="/twitch" class="block hover:text-fg-strong">Twitch</router-link>
            </div>
            <div class="space-y-1">
              <p class="mb-2 font-semibold uppercase tracking-wide text-fg-faint">Compte</p>
              <router-link v-if="canUseSite" to="/profil" class="block hover:text-fg-strong">Mon profil</router-link>
              <router-link v-if="canUseSite" to="/aide" class="block hover:text-fg-strong">Aide</router-link>
              <a href="/api/auth/discord" class="block hover:text-fg-strong">Connexion</a>
            </div>
          </div>
        </div>
        <p class="mt-8 border-t border-line pt-4 text-[11px] text-fg-faint">
          Le Bastion des Gamers — association gaming. Non affilié à Valve ni à Discord.
        </p>
      </div>
    </footer>
  </div>
</template>
