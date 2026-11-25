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
    <h1 class="text-2xl font-bold text-fg-strong">Guide et dépannage</h1>

    <!-- Accès Discord -->
    <section class="card mt-6">
      <h2 class="text-lg font-semibold text-fg-strong">0. Accès au site</h2>
      <p class="mt-2 text-sm text-fg-muted">
        L'accès est réservé aux <strong class="text-fg">membres du serveur
        Discord</strong>. À chaque connexion, le site vérifie via le bot que ton
        compte fait bien partie du serveur : si c'est le cas, tu entres
        directement, sans autorisation à demander.
      </p>
      <p class="mt-2 text-sm text-fg-muted">
        Des exceptions peuvent être ajoutées par un administrateur depuis la page
        Administration, pour les personnes qui ne sont pas sur le serveur.
      </p>
      <p class="mt-2 text-sm text-fg-muted">
        Si tu tombes sur « Compte hors du serveur », la page propose de rejoindre
        le serveur puis de te reconnecter. Si tu penses être membre, réessaie :
        la vérification peut échouer momentanément si Discord est injoignable.
      </p>
      <p class="mt-2 text-xs text-fg-faint">
        Comment trouver ton ID : Discord → Paramètres → Avancés → active le
        Mode développeur, puis clic droit sur ton pseudo → Copier l'identifiant.
        Il sert uniquement si un administrateur doit t'autoriser manuellement.
      </p>
    </section>

    <!-- Événements Discord -->
    <section class="card mt-6">
      <h2 class="font-display text-lg font-semibold text-fg-strong">Événements du serveur Discord</h2>
      <p class="mt-2 text-sm text-fg-muted">
        Les événements affichés sur le site sont ceux créés sur le serveur
        Discord. Un administrateur peut aussi en
        <strong class="text-fg">créer directement depuis le site</strong> :
        bouton « Créer un événement » en haut de la page Événements, puis un
        formulaire (nom, date, durée, salon vocal ou lieu externe). L'événement
        est créé sur Discord et apparaît aussitôt ici.
      </p>

      <p class="mt-3 text-sm font-semibold text-fg-strong">Configuration (administrateur)</p>
      <ol class="mt-2 space-y-2 text-sm text-fg-muted">
        <li>
          <span class="text-gold">1.</span> Sur
          <a href="https://discord.com/developers/applications" target="_blank" rel="noopener" class="text-brand hover:underline">le portail développeur</a>,
          ouvre l'application du site puis l'onglet <strong class="text-fg">Bot</strong>.
        </li>
        <li>
          <span class="text-gold">2.</span> <strong class="text-fg">Reset Token</strong> et copie la valeur
          dans la variable <code class="text-brand">DISCORD_BOT_TOKEN</code>.
        </li>
        <li>
          <span class="text-gold">3.</span> Dans l'onglet <strong class="text-fg">Installation</strong>,
          assure-toi que le scope <code class="text-brand">bot</code> est inclus, puis
          invite le bot sur ton serveur avec les permissions <em>Créer des
          événements</em> et <em>Gérer les événements</em>. Attention : la
          seconde ne suffit pas pour créer un événement, Discord exige les deux.
          Si le bot est déjà invité, active-les sur son rôle :
          Paramètres du serveur → Rôles → rôle du bot.
        </li>
        <li>
          <span class="text-gold">4.</span> Récupère l'identifiant du serveur : active le
          <strong class="text-fg">mode développeur</strong> (Paramètres → Avancés), puis clic droit
          sur l'icône du serveur → <em>Copier l'identifiant du serveur</em>. Renseigne
          <code class="text-brand">DISCORD_GUILD_ID</code>.
        </li>
        <li>
          <span class="text-gold">5.</span> Redéploie, puis clique sur
          <strong class="text-fg">Synchroniser</strong> en haut de la page Événements.
        </li>
      </ol>

      <p class="mt-3 text-xs text-fg-muted">
        <strong class="text-fg">Aucune intention privilégiée n'est nécessaire.</strong>
        La lecture passe par l'API REST, pas par la passerelle temps réel : le bot
        n'a pas besoin d'être en ligne. C'est aussi pour cela qu'il n'apparaît pas
        dans la liste des membres — Discord masque les membres hors ligne. Vérifie
        sa présence dans <em>Paramètres du serveur → Intégrations</em>.
      </p>
      <p class="mt-3 text-xs text-fg-faint">
        Erreur 403 ? Le bot n'a pas la permission « Créer des événements »
        (distincte de « Gérer les événements »), ou il n'est pas sur le serveur.
        Erreur 401 ? Le jeton est invalide ou a été régénéré. Erreur 404 sur la
        vérification des membres ? Le bot n'est pas membre du serveur : c'est la
        même cause que pour les événements.
      </p>
      <p class="mt-3 text-xs text-fg-muted">
        <strong class="text-fg">Le même bot</strong> sert à vérifier que chaque
        visiteur est bien membre du serveur. Tant qu'il n'est pas configuré,
        seules les exceptions de la page Administration peuvent se connecter.
      </p>
    </section>

    <!-- Réglages Steam -->
    <section class="card mt-6">
      <h2 class="text-lg font-semibold text-fg-strong">
        1. Rendre son profil Steam public
      </h2>
      <p class="mt-2 text-sm text-fg-muted">
        C'est indispensable. Sans ça, Steam refuse de communiquer la ludothèque
        et les temps de jeu. Ajouter quelqu'un à un groupe Steam
        <strong class="text-fg">ne sert à rien</strong> : l'API interroge
        les profils de façon anonyme, sans tenir compte de votre relation
        d'amitié.
      </p>

      <ol class="mt-4 space-y-3 text-sm text-fg">
        <li class="flex gap-3">
          <span class="badge h-5 w-5 shrink-0 items-center justify-center bg-app-surface2 text-brand">1</span>
          <span>Ouvre ton profil Steam, puis <strong>Modifier le profil</strong>.</span>
        </li>
        <li class="flex gap-3">
          <span class="badge h-5 w-5 shrink-0 items-center justify-center bg-app-surface2 text-brand">2</span>
          <span>Va dans <strong>Paramètres de confidentialité</strong>.</span>
        </li>
        <li class="flex gap-3">
          <span class="badge h-5 w-5 shrink-0 items-center justify-center bg-app-surface2 text-brand">3</span>
          <span>
            <strong>État du profil</strong> →
            <span class="text-ok">Public</span>
          </span>
        </li>
        <li class="flex gap-3">
          <span class="badge h-5 w-5 shrink-0 items-center justify-center bg-app-surface2 text-brand">4</span>
          <span>
            <strong>Détails du jeu</strong> →
            <span class="text-ok">Toujours afficher les détails du jeu</span>
            <br />
            <span class="text-xs text-fg-faint">
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
      <h2 class="text-lg font-semibold text-fg-strong">
        2. Pourquoi les genres se remplissent progressivement
      </h2>
      <p class="mt-2 text-sm text-fg-muted">
        L'API officielle (<code class="text-brand">GetOwnedGames</code>) ne
        renvoie <strong class="text-fg">pas les genres ni les tags</strong>.
        Elle donne seulement l'identifiant, le nom et le temps de jeu.
      </p>
      <p class="mt-2 text-sm text-fg-muted">
        Les styles proviennent d'une autre API, celle du Steam Store
        (<code class="text-brand">appdetails</code>), qui est lente
        (~200 ms par jeu) et limitée à environ 200 requêtes toutes les 5 minutes.
      </p>
      <p class="mt-2 text-sm text-fg">
        Conséquence : chaque jeu est enrichi
        <strong>une seule fois</strong>, puis partagé entre tous les membres.
        L'enrichissement se fait par petits lots. Clique plusieurs fois sur
        « Enrichir les genres » et les filtres deviendront complets.
      </p>
      <p class="mt-2 text-xs text-fg-faint">
        Un jeu non enrichi s'affiche avec le badge « genres ? » et ne correspond
        à aucun filtre de style. C'est assumé : mieux vaut ne rien afficher que
        d'inventer un genre.
      </p>
    </section>

    <!-- Limites assumées -->
    <section class="card mt-6">
      <h2 class="text-lg font-semibold text-fg-strong">3. Limites connues</h2>
      <ul class="mt-3 space-y-2 text-sm text-fg-muted">
        <li>
          • Les propositions viennent des jeux déjà présents dans le groupe.
          Steam n'expose pas de classement des ventes sans clé partenaire, donc
          on ne peut pas suggérer un jeu totalement inconnu ici.
        </li>
        <li>
          • Le scoring vise le <strong class="text-fg">dénominateur commun</strong>.
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
      <h2 class="text-lg font-semibold text-fg-strong">4. État du groupe</h2>

      <div v-if="loading" class="mt-3 h-20 animate-pulse rounded bg-app-surface2"></div>
      <div v-else-if="members.length === 0" class="mt-3 text-sm text-fg-faint">
        Personne n'est encore connecté.
      </div>
      <ul v-else class="mt-3 divide-y divide-line">
        <li v-for="m in members" :key="m.steamid" class="flex flex-wrap items-center gap-3 py-2">
          <img v-if="m.discordAvatar || m.steamAvatar" :src="m.discordAvatar || m.steamAvatar" :alt="m.displayName" class="h-8 w-8 rounded-full border border-line" />
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm text-fg">{{ m.displayName || m.personaName }}</p>
            <p class="text-xs text-fg-faint">Dernière synchro : {{ since(m.lastSyncAt) }}</p>
          </div>
          <div class="flex gap-1">
            <span v-if="!m.profileVisible" class="badge bg-danger-soft text-danger">profil privé</span>
            <span v-else-if="!m.gamesVisible" class="badge bg-warn-soft text-warn">temps de jeu masqués</span>
            <span v-else class="badge bg-ok-soft text-ok">ok</span>
          </div>
          <p v-if="m.lastSyncError" class="w-full text-xs text-danger">{{ m.lastSyncError }}</p>
        </li>
      </ul>
    </section>

    <!-- Sécurité -->
    <section class="card mt-6">
      <h2 class="text-lg font-semibold text-fg-strong">5. Sécurité</h2>
      <ul class="mt-3 space-y-2 text-sm text-fg-muted">
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
