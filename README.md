# Le Bastion des Gamers

Site de l'association **Le Bastion des Gamers** : on rassemble les ludothèques
des membres (Steam, GOG, Epic) pour savoir **à quoi on peut jouer ensemble ce
soir**. Communauté PC, réservée aux 18 ans et plus.

Production : <https://lbdg.eu> · dépôt : <https://github.com/JamesDAdams/steam-match>

---

## Ce que fait le site

| Page | Contenu |
|---|---|
| **Événements** | Rendez-vous du serveur Discord, lus via l'API du bot (public) |
| **Jeux en commun** | Intersection des ludothèques, filtre par membres / genres / tags (membres) |
| **Sorties** | Calendrier des sorties attendues, à partir des wishlists ; bascule « mes sorties » / « tout le serveur » |
| **Récap'** | Chiffres des N derniers jours (page texte, publique en option) + image générée et publiée dans Discord |
| **Membres** | Annuaire et fiches ; chaque personne choisit ce qui est public |
| **Profil** | Ludothèque fusionnée Steam + GOG + Epic, wishlist, comptes liés, Twitch, visibilité |
| **Twitch** | Chaînes de la communauté (public) |
| **Admin** | Synchronisation Steam, rappels de sortie, récap', pages visibles, autorisations, comptes |

Fonctionnement notable :

- **Fusion des plateformes** : Steam, GOG et Epic n'ont pas d'identifiant commun ;
  les jeux sont rapprochés par titre normalisé (suffixes d'édition retirés) —
  voir `src/lib/library.ts`.
- **Temps de jeu** : Steam fait foi ; Epic complète quand Steam n'a rien ; GOG
  n'expose pas d'heures. Les comptes « famille » sont exclus des totaux du récap'.
- **Visibilité** : la page Récap' et la page Sorties peuvent être publiques
  (réglages admin). Un visiteur non connecté voit des chiffres et un nombre de
  membres, **jamais** les pseudos Steam ni Discord.
- **Cron Netlify** : synchronisation Steam (toutes les heures), publications
  Discord (sorties le matin, récap' à l'heure choisie), synchro GOG/Epic.

## Stack

- **Vue 3** + Vite + Tailwind (SPA, thème clair/sombre)
- **API** : fonctions Netlify (`netlify/functions/`), un routeur unique
  `api.ts` qui mappe `/api/*` vers `lib/handlers/` et `api/`
- **Base** : PostgreSQL (Neon) via Drizzle ORM (`db/schema.ts`)
- **Discord** : OAuth pour la connexion, bot REST pour les salons, messages et
  événements
- **Sécurité** : session signée en cookie, jetons GOG/Epic chiffrés en AES-256-GCM

## Démarrer en local

```bash
npm install
cp .env.example .env.local     # puis renseigne les variables (voir ci-dessous)
npm run db:schema              # applique le schéma (idempotent)
npm run dev                    # http://localhost:3000
```

`npm run dev` lance un serveur unique (Vite + routes API) : pas besoin de
`vercel dev`.

### Variables d'environnement

| Nom | Rôle |
|---|---|
| `DATABASE_URL` | chaîne de connexion Neon (avec `?sslmode=require`) |
| `SESSION_SECRET` | signature des cookies — `openssl rand -hex 32` (32 caractères minimum) |
| `BASE_URL` | URL publique du site, sans slash final (ex. `https://lbdg.eu`) |
| `STEAM_API_KEY` | <https://steamcommunity.com/dev/apikey> |
| `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` | application Discord (OAuth2) |
| `DISCORD_ADMIN_ID` | ton identifiant Discord (un ou plusieurs, séparés par des virgules) |
| `DISCORD_BOT_TOKEN` | bot du serveur (salons, messages, événements) |
| `DISCORD_GUILD_ID` | identifiant du serveur |
| `DISCORD_INVITE_URL` | facultatif — lien d'invitation affiché aux comptes refusés |
| `GG_DEALS_API_KEY` | facultatif — prix des clés (gg.deals) |

⚠️ `BASE_URL + /api/auth/discord-callback` doit figurer **à l'identique** dans
Discord → OAuth2 → Redirects, sinon Discord répond `invalid redirect_uri`.

### Scripts

| Commande | Effet |
|---|---|
| `npm run dev` | serveur de développement (front + API) |
| `npm run build` | build de production du front |
| `npm run check` | types (vue-tsc) + rendu des vues + chargement des fonctions |
| `npm run db:schema` | applique le schéma SQL (idempotent) |
| `npm run db:inspect` | état de la base (compteurs) |
| `npm run test:netlify` | vérifie les routes de l'API en local |

## Déploiement

Hébergement **Netlify** (site `le-bastion-des-gamers`), domaine `lbdg.eu`
(DNS chez Cloudflare, proxy désactivé, certificat Let's Encrypt géré par
Netlify), base **Neon**.

```bash
git push origin main     # Netlify construit et déploie
```

- Les variables d'environnement Netlify sont figées **par déploiement** : après
  un changement, il faut redéployer.
- `DEPLOIEMENT.md` contient l'ancien guide Vercel, conservé pour historique ;
  le déploiement actuel est bien Netlify.

## Structure

```
api/              routes historiques Vercel (auth, me, common, group…)
lib/handlers/     handlers de l'API (recap, members, admin-settings…)
lib/              logique métier (steam, gog, epic, recap, releases, access…)
db/               schéma Drizzle
netlify/functions api.ts (routeur) + tâches planifiées *-cron.ts
src/              application Vue (views, composants, lib partagée)
scripts/          migrations, vérifications, tests manuels
server/           serveur de développement
```

## Qualité

- `npm run check` passe avant chaque commit (husky + scan de secrets).
- Les pages se rendent sans JS côté serveur : `check:vues` vérifie chaque vue.
- Toute écriture en base passe par Drizzle ; le schéma est appliqué par
  `scripts/apply-schema.mjs` (aucune donnée détruite).
