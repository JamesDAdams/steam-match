# Déploiement sur Vercel

Ce guide décrit la mise en production. Le build a déjà été validé par un
déploiement temporaire : le front, le fallback SPA et les 15 fonctions API
compilent correctement.

## 1. Importer le dépôt

Le code est sur https://github.com/JamesDAdams/steam-match (privé).

1. https://vercel.com/new
2. **Import Git Repository** → autorise Vercel sur GitHub si demandé
3. Choisis `steam-match`
4. Ne change rien au build : Vercel détecte Vite (`vercel.json` est déjà réglé)
5. **Deploy**

Le premier déploiement réussira mais l'application sera cassée : les variables
d'environnement manquent.

## 2. Variables d'environnement

Project → **Settings** → **Environment Variables** (coche Production,
Preview et Development pour chacune).

| Nom | Valeur |
|---|---|
| `STEAM_API_KEY` | ta clé — https://steamcommunity.com/dev/apikey |
| `DATABASE_URL` | chaîne Neon (celle du tableau de bord, avec `-pooler` et `?sslmode=require`) |
| `SESSION_SECRET` | `openssl rand -hex 32` — **génère-en un nouveau pour la prod** |
| `BASE_URL` | `https://TON-PROJET.vercel.app` (sans slash final) |
| `DISCORD_CLIENT_ID` | portail Discord → OAuth2 |
| `DISCORD_CLIENT_SECRET` | portail Discord → OAuth2 → Reset Secret |
| `DISCORD_ADMIN_ID` | ton ID Discord |

## 3. Redirection Discord

Dans https://discord.com/developers/applications → ton application → **OAuth2**
→ **Redirects**, ajoute **en plus** de l'URL locale :

```
https://TON-PROJET.vercel.app/api/auth/discord-callback
```

Garde `http://localhost:3000/api/auth/discord-callback` pour continuer à
développer en local.

⚠️ L'URL doit correspondre au caractère près à `BASE_URL + /api/auth/discord-callback`,
sinon Discord renvoie `invalid redirect_uri`.

## 4. Redéployer

Après ajout des variables : **Deployments** → les trois points du dernier
déploiement → **Redeploy**. Les variables ne sont prises en compte qu'au
déploiement suivant.

## 5. Vérifications

```bash
curl -I https://TON-PROJET.vercel.app/            # 200, text/html
curl -s https://TON-PROJET.vercel.app/api/me      # {"ok":true,"authenticated":false}
curl -sI https://TON-PROJET.vercel.app/aide       # 200 (fallback SPA)
```

Puis ouvre le site : connexion Discord, page Admin, liaison Steam, sync.

## Notes

- **La base est partagée** entre local et prod : même Neon. Les données de test
  locales apparaîtront en production. Pour séparer, crée une seconde branche
  Neon (`dev`) et utilise sa chaîne en local.
- **`DISCORD_CLIENT_SECRET`** doit être reset s'il a circulé (courriel, ticket,
  capture d'écran) : portail Discord → Reset Secret, puis mets à jour Vercel.
- **Clé Steam** : elle n'est pas liée au domaine déclaré, `localhost` fonctionne
  aussi en production. Tu peux la régénérer pour la propreté.
- **Le plan gratuit Vercel** limite le temps d'exécution des fonctions à 10 s.
  `/api/enrich` traite 15 jeux (~4 s) : c'est volontairement sous la limite.
  Pour enrichir plus vite, il faudra un cron qui appelle `/api/enrich` en boucle.
