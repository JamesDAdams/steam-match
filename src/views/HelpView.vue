<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { apiGet } from '../lib/api';

const members = ref<any[]>([]);
const loading = ref(true);

onMounted(async () => {
  try {
    const g = await apiGet<{ members: any[] }>('/api/group');
    members.value = g.members ?? [];
  } catch {
  } finally {
    loading.value = false;
  }
});

function since(d: string | Date | null) {
  if (!d) return 'jamais';
  const date = new Date(d);
  const mins = Math.floor((Date.now() - date.getTime()) / 60000);
  if (mins < 1) return "à l'instant";
  if (mins < 60) return `il y a ${mins} min`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `il y a ${h} h`;
  return `il y a ${Math.floor(h / 24)} j`;
}
</script>

<template>
  <div class="mx-auto max-w-3xl">
    <h1 class="text-2xl font-bold text-white">Guide et dépannage</h1>

    <!-- Accès Discord -->
    <section class="card mt-6">
      <h2 class="text-lg font-semibold text-white">0. Accès au site</h2>
      <p class="mt-2 text-sm text-slate-400">
        Le site est fermé : seuls les comptes Discord autorisés par
        l'administrateur peuvent y entrer. La connexion se fait via Discord,
        puis on relie son compte Steam.
      </p>
      <p class="mt-2 text-sm text-slate-400">
        Si tu tombes sur « Accès non autorisé », la page t'affiche ton
        identifiant Discord : transmets-le à l'administrateur, qui l'ajoutera
        depuis la page d'administration.
      </p>
      <p class="mt-2 text-xs text-slate-500">
        Comment trouver ton ID : Discord → Paramètres → Avancés → active le
        Mode développeur, puis clic droit sur ton pseudo → Copier l'identifiant.
      </p>
    </section>

    <!-- Réglages Steam -->
    <section class="card mt-6">
      <h2 class="text-lg font-semibold text-white">
        1. Rendre son profil Steam public
      </h2>
      <p class="mt-2 text-sm text-slate-400">
        C'est indispensable. Sans ça, Steam refuse de communiquer la ludothèque
        et les temps de jeu. Ajouter quelqu'un à un groupe Steam
        <strong class="text-slate-200">ne sert à rien</strong> : l'API interroge
        les profils de façon anonyme, sans tenir compte de votre relation
        d'amitié.
      </p>

      <ol class="mt-4 space-y-3 text-sm text-slate-300">
        <li class="flex gap-3">
          <span class="badge h-5 w-5 shrink-0 items-center justify-center bg-steam-navy text-steam-blue">1</span>
          <span>Ouvre ton profil Steam, puis <strong>Modifier le profil</strong>.</span>
        </li>
        <li class="flex gap-3">
          <span class="badge h-5 w-5 shrink-0 items-center justify-center bg-steam-navy text-steam-blue">2</span>
          <span>Va dans <strong>Paramètres de confidentialité</strong>.</span>
        </li>
        <li class="flex gap-3">
          <span class="badge h-5 w-5 shrink-0 items-center justify-center bg-steam-navy text-steam-blue">3</span>
          <span>
            <strong>État du profil</strong> →
            <span class="text-emerald-300">Public</span>
          </span>
        </li>
        <li class="flex gap-3">
          <span class="badge h-5 w-5 shrink-0 items-center justify-center bg-steam-navy text-steam-blue">4</span>
          <span>
            <strong>Détails du jeu</strong> →
            <span class="text-emerald-300">Toujours afficher les détails du jeu</span>
            <br />
            <span class="text-xs text-slate-500">
              Sans cette option : la ludothèque est renvoyée, mais tous les
              temps de jeu valent 0 → les recommandations ne fonctionnent pas.
            </span>
          </span>
        </li>
      </ol>

      <a
        href="https://steamcommunity.com/my/edit/settings"
        target="_blank"
        rel="noopener"
        class="btn-primary mt-4 text-sm"
      >
        Ouvrir mes paramètres Steam
      </a>
    </section>

    <!-- Pourquoi les genres arrivent en retard -->
    <section class="card mt-6">
      <h2 class="text-lg font-semibold text-white">
        2. Pourquoi les genres se remplissent progressivement
      </h2>
      <p class="mt-2 text-sm text-slate-400">
        L'API officielle (<code class="text-steam-blue">GetOwnedGames</code>) ne
        renvoie <strong class="text-slate-200">pas les genres ni les tags</strong>.
        Elle donne seulement l'identifiant, le nom et le temps de jeu.
      </p>
      <p class="mt-2 text-sm text-slate-400">
        Les styles proviennent d'une autre API, celle du Steam Store
        (<code class="text-steam-blue">appdetails</code>), qui est lente
        (~200 ms par jeu) et limitée à environ 200 requêtes toutes les 5 minutes.
      </p>
      <p class="mt-2 text-sm text-slate-300">
        Conséquence : chaque jeu est enrichi
        <strong>une seule fois</strong>, puis partagé entre tous les membres.
        L'enrichissement se fait par petits lots. Clique plusieurs fois sur
        « Enrichir les genres » et les filtres deviendront complets.
      </p>
      <p class="mt-2 text-xs text-slate-500">
        Un jeu non enrichi s'affiche avec le badge « genres ? » et ne correspond
        à aucun filtre de style. C'est assumé : mieux vaut ne rien afficher que
        d'inventer un genre.
      </p>
    </section>

    <!-- Limites assumées -->
    <section class="card mt-6">
      <h2 class="text-lg font-semibold text-white">3. Limites connues</h2>
      <ul class="mt-3 space-y-2 text-sm text-slate-400">
        <li>
          • Les propositions viennent des jeux déjà présents dans le groupe.
          Steam n'expose pas de classement des ventes sans clé partenaire, donc
          on ne peut pas suggérer un jeu totalement inconnu ici.
        </li>
        <li>
          • Le scoring vise le <strong class="text-slate-200">dénominateur commun</strong>.
          Un jeu très apprécié par une seule personne ne remontera pas, même
          excellent. C'est le but.
        </li>
        <li>
          • Aucune note ni critique n'est utilisée — uniquement les heures
          jouées, ce qui reste un signal imparfait (un jeu lancé puis abandonné
          compte aussi).
        </li>
      </ul>
    </section>

    <!-- État du groupe -->
    <section class="card mt-6">
      <h2 class="text-lg font-semibold text-white">4. État du groupe</h2>

      <div v-if="loading" class="mt-3 h-20 animate-pulse rounded bg-white/5"></div>
      <div v-else-if="members.length === 0" class="mt-3 text-sm text-slate-500">
        Personne n'est encore connecté.
      </div>
      <ul v-else class="mt-3 divide-y divide-white/10">
        <li v-for="m in members" :key="m.steamid" class="flex flex-wrap items-center gap-3 py-2">
          <img v-if="m.discordAvatar || m.steamAvatar" :src="m.discordAvatar || m.steamAvatar" :alt="m.displayName" class="h-8 w-8 rounded-full border border-white/15" />
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm text-slate-200">{{ m.displayName || m.personaName }}</p>
            <p class="text-xs text-slate-500">Dernière synchro : {{ since(m.lastSyncAt) }}</p>
          </div>
          <div class="flex gap-1">
            <span v-if="!m.profileVisible" class="badge bg-red-500/20 text-red-300">profil privé</span>
            <span v-else-if="!m.gamesVisible" class="badge bg-amber-500/20 text-amber-300">temps de jeu masqués</span>
            <span v-else class="badge bg-emerald-500/20 text-emerald-300">ok</span>
          </div>
          <p v-if="m.lastSyncError" class="w-full text-xs text-red-400">{{ m.lastSyncError }}</p>
        </li>
      </ul>
    </section>

    <!-- Sécurité -->
    <section class="card mt-6">
      <h2 class="text-lg font-semibold text-white">5. Sécurité</h2>
      <ul class="mt-3 space-y-2 text-sm text-slate-400">
        <li>• Aucun mot de passe Steam n'est demandé : l'authentification passe par OpenID.</li>
        <li>• On ne lit que des données publiques (pseudo, avatar, jeux, temps de jeu).</li>
        <li>
          • Ta clé API Steam reste sur le serveur, dans les variables
          d'environnement Vercel. Elle n'est jamais envoyée au navigateur ni
          commitée sur Git.
        </li>
      </ul>
    </section>
  </div>
</template>
