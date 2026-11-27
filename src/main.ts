import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import App from './App.vue';
import './style.css';

import LoginView from './views/LoginView.vue';
import EventsView from './views/EventsView.vue';
import ProfileView from './views/ProfileView.vue';
import CommonView from './views/CommonView.vue';
import RecommendView from './views/RecommendView.vue';
import AdminView from './views/AdminView.vue';
import TwitchView from './views/TwitchView.vue';
import MembersView from './views/MembersView.vue';
import MemberView from './views/MemberView.vue';
import ReleasesView from './views/ReleasesView.vue';
import RecapView from './views/RecapView.vue';

import { refreshAuth } from './lib/guard.ts';

const routes = [
  { path: '/', name: 'login', component: LoginView },
  // Page publique : consultable sans compte.
  { path: '/evenements', name: 'events', component: EventsView },
  {
    path: '/profil',
    name: 'profile',
    component: ProfileView,
    meta: { requiresAccess: true },
  },
  { path: '/commun', name: 'common', component: CommonView, meta: { requiresAccess: true } },
  {
    path: '/recommandations',
    name: 'recommend',
    component: RecommendView,
    // Page en chantier : masquée tant que l'admin ne l'active pas.
    meta: { requiresAccess: true, requiresFeature: 'recommendations' },
  },
  // Page publique : consultable sans compte.
  { path: '/twitch', name: 'twitch', component: TwitchView },
  {
    path: '/sorties',
    name: 'releases',
    component: ReleasesView,
    meta: { requiresAccess: true },
  },
  {
    path: '/recap',
    name: 'recap',
    component: RecapView,
    /*
     * Page PUBLIQUE (quand l'admin l'autorise) : pas de garde ici, sinon un
     * visiteur sans compte serait renvoyé à l'accueil. L'API décide — elle
     * renvoie les chiffres avec les pseudos pour un membre, sans les pseudos
     * pour un anonyme, et 401 si la page n'est pas publiée.
     */
  },
  /*
   * Annuaire et fiches PUBLICS. Ce que montre une fiche dépend des réglages
   * de la personne (profil ouvert / chiffres publics, fermés par défaut) :
   * c'est l'API qui tranche, pas le routeur.
   */
  { path: '/membres', name: 'members', component: MembersView },
  { path: '/membres/:discordId', name: 'member', component: MemberView },
  {
    path: '/admin',
    name: 'admin',
    component: AdminView,
    meta: { requiresAdmin: true },
  },
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

/**
 * Garde global : on interroge /api/me avant d'entrer sur une page protégée.
 * Ce n'est qu'un confort d'affichage — le vrai contrôle est côté API, où
 * chaque route appelle requireAccess()/requireAdmin().
 */
router.beforeEach(async (to) => {
  if (!to.meta.requiresAccess && !to.meta.requiresAdmin) return true;

  const state = await refreshAuth();

  if (!state.authenticated || state.allowed !== true) {
    // On transmet la page demandée : l'accueil affichera « connecte-toi pour
    // continuer » au lieu de laisser croire que la page est vide.
    return { path: '/', query: { from: to.fullPath } };
  }
  if (to.meta.requiresAdmin && !state.isAdmin) {
    return { path: '/commun' };
  }

  // Fonctionnalité masquée : l'admin garde l'aperçu, les autres sont redirigés.
  const feature = to.meta.requiresFeature as string | undefined;
  if (feature) {
    const enabled = (state.features as Record<string, boolean> | undefined)?.[feature];
    if (!enabled && !state.isAdmin) {
      return { path: '/commun' };
    }
  }
  return true;
});

const app = createApp(App);

/**
 * Filet de sécurité : sans ça, une erreur de rendu laisse une page
 * entièrement blanche et silencieuse. On affiche le message à l'écran
 * (et en console) pour pouvoir diagnostiquer immédiatement.
 */
app.config.errorHandler = (err, _instance, info) => {
  console.error('[vue] erreur de rendu :', err, '\n  contexte :', info);
  let box = document.getElementById('fatal-error');
  if (!box) {
    box = document.createElement('div');
    box.id = 'fatal-error';
    box.style.cssText =
      'position:fixed;inset:auto 0 0 0;z-index:9999;background:#3b0d0d;color:#fecaca;' +
      'padding:12px 16px;font:13px/1.5 ui-monospace,monospace;border-top:2px solid #ef4444;' +
      'white-space:pre-wrap;max-height:40vh;overflow:auto';
    document.body.appendChild(box);
  }
  box.textContent =
    'Erreur de rendu Vue : ' +
    (err instanceof Error ? err.message : String(err)) +
    '\nContexte : ' +
    info +
    '\nDétails complets dans la console (F12).';
};

// Une navigation qui échoue ne doit pas rester muette non plus.
router.onError((err) => {
  console.error('[router]', err);
});

app.use(router).mount('#app');
