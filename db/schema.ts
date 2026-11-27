import {
  pgTable,
  text,
  integer,
  date,
  timestamp,
  jsonb,
  boolean,
  index,
  primaryKey,
} from 'drizzle-orm/pg-core';

/**
 * MODÈLE D'IDENTITÉ
 * -----------------
 * Discord est la PORTE D'ENTRÉE du site. Steam n'est qu'une LIAISON
 * facultative : quelqu'un peut se connecter avec Discord sans avoir encore
 * relié son compte Steam.
 *
 *   discord_users  ──1:0..1──  steam_links  ──1:1──  users (Steam)
 *          │
 *          └── sessions
 *
 * L'accès est contrôlé par allowed_discord_ids (whitelist) + DISCORD_ADMIN_ID.
 */

/** Compte Discord ayant déjà ouvert le site au moins une fois. */
export const discordUsers = pgTable('discord_users', {
  discordId: text('discord_id').primaryKey(),
  username: text('username').notNull(),
  globalName: text('global_name'),
  avatarUrl: text('avatar_url'),
  isAdmin: boolean('is_admin').notNull().default(false),
  /**
   * Appartenance au serveur Discord, vérifiée via le bot.
   *
   * C'est le second critère d'accès : un membre du serveur entre sans
   * autorisation manuelle. `memberCheckedAt` sert de cache (l'appel Discord
   * n'est refait qu'après quelques minutes) et de trace de la dernière
   * vérification réussie.
   */
  isMember: boolean('is_member').notNull().default(false),
  memberCheckedAt: timestamp('member_checked_at', { withTimezone: true }),
  /**
   * VISIBILITÉ PUBLIQUE (réglée par la personne sur son profil).
   *
   * `gamesPublic` : nombre de jeux et temps de jeu visibles par les visiteurs
   * NON CONNECTÉS (dans l'annuaire et sur la fiche).
   * `profilePublic` : la fiche est consultable sans compte (ludothèque
   * comprise). Les membres connectés du site voient toujours tout : ces
   * réglages ne concernent que l'extérieur.
   *
   * Défaut false dans les deux cas : personne n'est exposé sans l'avoir voulu.
   */
  gamesPublic: boolean('games_public').notNull().default(false),
  profilePublic: boolean('profile_public').notNull().default(false),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Whitelist administrée depuis la page admin.
 * Un discord_id absent de cette table n'a pas accès au site
 * (sauf s'il est dans DISCORD_ADMIN_ID).
 */
export const allowedDiscordIds = pgTable('allowed_discord_ids', {
  discordId: text('discord_id').primaryKey(),
  note: text('note'),
  addedBy: text('added_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Table Steam (ludothèque). Remplie uniquement après liaison OpenID. */
export const users = pgTable('users', {
  steamid: text('steamid').primaryKey(),
  personaName: text('persona_name').notNull(),
  avatarUrl: text('avatar_url'),
  profileUrl: text('profile_url'),

  // Visibilité détectée lors du dernier sync.
  profileVisible: boolean('profile_visible').notNull().default(false),
  gamesVisible: boolean('games_visible').notNull().default(false),

  lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
  lastSyncError: text('last_sync_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Association Discord ↔ Steam.
 * steamid est UNIQUE : deux comptes Discord ne peuvent pas revendiquer
 * le même compte Steam.
 */
export const steamLinks = pgTable(
  'steam_links',
  {
    discordId: text('discord_id')
      .primaryKey()
      .references(() => discordUsers.discordId, { onDelete: 'cascade' }),
    steamid: text('steamid')
      .notNull()
      .unique()
      .references(() => users.steamid, { onDelete: 'cascade' }),
    linkedAt: timestamp('linked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    bySteam: index('steam_links_steam_idx').on(t.steamid),
  }),
);

/**
 * Sessions : Vercel est serverless, pas de session en mémoire.
 * Le token opaque va dans un cookie httpOnly.
 */
export const sessions = pgTable(
  'sessions',
  {
    token: text('token').primaryKey(),
    discordId: text('discord_id')
      .notNull()
      .references(() => discordUsers.discordId, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byUser: index('sessions_discord_idx').on(t.discordId),
  }),
);

/**
 * Ludothèque d'un utilisateur Steam.
 * playtimeForever = minutes. Vaut 0 si « Détails du jeu » n'est pas public.
 */
export const ownedGames = pgTable(
  'owned_games',
  {
    steamid: text('steamid')
      .notNull()
      .references(() => users.steamid, { onDelete: 'cascade' }),
    appid: integer('appid').notNull(),
    playtimeForever: integer('playtime_forever').notNull().default(0),
    playtime2Weeks: integer('playtime_2weeks').notNull().default(0),
    /**
     * Origine du jeu :
     *   'owned'  → acheté par le membre (renvoyé par GetOwnedGames)
     *   'family' → rendu jouable par sa famille Steam, déclaré à la main
     *
     * POURQUOI À LA MAIN : IPlayerService/GetOwnedGames ignore les jeux
     * partagés, et IFamilyGroupsService/GetSharedLibraryApps exige un
     * `access_token` de session navigateur (JWT court), pas la clé Web API du
     * site. Aucun appel serveur ne peut donc les découvrir.
     *
     * La synchronisation ne touche jamais les lignes 'family' : elles
     * disparaîtraient à chaque sync puisque GetOwnedGames ne les renvoie pas.
     */
    source: text('source').notNull().default('owned'),
    /**
     * Compte Steam d'où vient le jeu quand `source` vaut 'secondary' ou
     * 'family' : identifie le compte à re-synchroniser, et permet de retirer
     * exactement ses jeux quand on le délie.
     */
    sourceSteamid: text('source_steamid'),
    /**
     * Dernier lancement connu du jeu (rtime_last_played de GetOwnedGames).
     *
     * Sert au récap' « jeux lancés ces N derniers jours ». Steam ne donne pas
     * d'historique par jour : ce champ, lui, est rétroactif dès la première
     * synchronisation — contrairement aux snapshots de playtime_daily.
     */
    lastPlayedAt: timestamp('last_played_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.steamid, t.appid] }),
    byApp: index('owned_games_app_idx').on(t.appid),
  }),
);

/**
 * Comptes Steam supplémentaires d'un membre.
 *
 * Un joueur peut avoir plusieurs comptes (un principal, un secondaire) ou
 * profiter de la bibliothèque de sa famille Steam. Aucun de ces comptes n'est
 * visible via `GetOwnedGames` du compte principal : on les déclare donc ici,
 * puis on aspire leur ludothèque publique et on marque chaque jeu de son
 * origine pour l'afficher dans la ludothèque.
 *
 * `kind` :
 *   'secondary' → autre compte du même joueur
 *   'family'    → compte d'un proche partageant sa bibliothèque (Steam Families)
 */
export const steamAccounts = pgTable(
  'steam_accounts',
  {
    ownerSteamid: text('owner_steamid')
      .notNull()
      .references(() => users.steamid, { onDelete: 'cascade' }),
    steamid: text('steamid').notNull(),
    kind: text('kind').notNull().default('family'),
    /** Pseudo Steam au moment de l'ajout, pour un affichage lisible. */
    personaName: text('persona_name'),
    avatarUrl: text('avatar_url'),
    gamesCount: integer('games_count').notNull().default(0),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.ownerSteamid, t.steamid] }),
  }),
);

/**
 * Wishlist Steam d'un membre.
 *
 * Récupérée via IWishlistService/GetWishlist. Comme la ludothèque, elle doit
 * être publique côté Steam (paramètre « Détails du jeu »).
 *
 * L'intérêt pour un groupe : un jeu souhaité par plusieurs personnes, et
 * surtout un jeu souhaité par l'un et déjà possédé par l'autre — jouable
 * immédiatement, sans achat.
 */
export const wishlistItems = pgTable(
  'wishlist_items',
  {
    steamid: text('steamid')
      .notNull()
      .references(() => users.steamid, { onDelete: 'cascade' }),
    appid: integer('appid').notNull(),
    priority: integer('priority').notNull().default(0),
    /**
     * Compte Steam d'où vient le souhait : NULL pour le compte principal,
     * sinon l'identifiant du compte secondaire (les comptes famille ne
     * fournissent jamais de wishlist).
     */
    sourceSteamid: text('source_steamid'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.steamid, t.appid] }),
    byApp: index('wishlist_items_app_idx').on(t.appid),
  }),
);

/**
 * Événements du serveur Discord.
 *
 * Source de vérité : Discord (Guild Scheduled Events). On ne crée rien ici,
 * on recopie ce que le serveur expose pour pouvoir l'afficher sur le site.
 *
 * Le bot doit avoir l'intention GUILD_SCHEDULED_EVENTS et être membre du
 * serveur pour lire les événements.
 */
export const discordEvents = pgTable(
  'discord_events',
  {
    /** Identifiant Discord du scheduled event (snowflake). */
    id: text('id').primaryKey(),
    guildId: text('guild_id').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    /** 1 = programmé, 2 = en cours, 3 = terminé, 4 = annulé (valeurs Discord). */
    status: integer('status').notNull().default(1),
    /** 1 = scène, 2 = vocal, 3 = externe. */
    entityType: integer('entity_type').notNull().default(3),
    /** Lien externe, ou identifiant du salon vocal/scène. */
    location: text('location'),
    coverImage: text('cover_image'),
    /** Nombre de personnes intéressées côté Discord. */
    interestedCount: integer('interested_count').notNull().default(0),
    /**
     * Personnes ayant coché « Intéressé » sur Discord, recopiées pour être
     * affichées sur le site (Discord ne les expose que via une route dédiée,
     * une fois par événement).
     */
    interestedUsers: jsonb('interested_users')
      .$type<{ id: string; name: string; avatarUrl: string | null }[]>()
      .notNull()
      .default([]),
    /** Dernière lecture de cette liste (on ne la relit pas à chaque sync). */
    interestedSyncedAt: timestamp('interested_synced_at', { withTimezone: true }),
    scheduledStartAt: timestamp('scheduled_start_at', { withTimezone: true }).notNull(),
    scheduledEndAt: timestamp('scheduled_end_at', { withTimezone: true }),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byStart: index('discord_events_start_idx').on(t.scheduledStartAt),
  }),
);

/**
 * Cache partagé des métadonnées de jeu.
 * GetOwnedGames ne renvoie PAS les genres : il faut appeler l'API du Store,
 * lente et limitée (~200 req / 5 min). On enrichit donc chaque appid une fois.
 */
export const gameCache = pgTable(
  'game_cache',
  {
    appid: integer('appid').primaryKey(),
    name: text('name').notNull(),
    headerImage: text('header_image'),
    genres: jsonb('genres').$type<string[]>().notNull().default([]),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    shortDescription: text('short_description'),

    // Prix de la clé la moins chère (comparateur CheapShark ou GG.deals).
    // Stocké en CENTIMES pour éviter les flottants. null = pas encore récupéré.
    cheapestPrice: integer('cheapest_price'),
    cheapestStore: text('cheapest_store'),
    // Devise du prix : EUR via GG.deals, USD via CheapShark. Sans elle on
    // risquerait d'afficher un montant en dollars avec un symbole euro.
    cheapestCurrency: text('cheapest_currency'),

    // Prix officiel Steam (EUR via cc=fr). Distinct du prix en clé : l'un est
    // la boutique officielle, l'autre le meilleur revendeur.
    steamPrice: integer('steam_price'),
    steamInitialPrice: integer('steam_initial_price'),
    steamDiscount: integer('steam_discount'),
    steamCurrency: text('steam_currency'),

    // Avis globaux Steam (via SteamSpy). L'évaluation « récente » n'est pas
    // accessible sans cookie de session Steam : on affiche donc l'avis global,
    // ce qui est honnête et stable.
    reviewPositive: integer('review_positive'),
    reviewNegative: integer('review_negative'),
    reviewScore: integer('review_score'),

    releaseDate: text('release_date'),
    // Modes de jeu extraits des catégories Steam : Solo, Multijoueur, Coopération…
    playModes: jsonb('play_modes').$type<string[]>().notNull().default([]),
    /** Type Steam de l'app : 'game', 'software', 'dlc', 'demo'… */
    appType: text('app_type'),
    /**
     * Raccourci calculé (voir lib/software.ts) : vrai pour un utilitaire.
     * Les listes « jeux » ne montrent que ce qui n'est pas marqué.
     */
    isSoftware: boolean('is_software').notNull().default(false),
    priceUpdatedAt: timestamp('price_updated_at', { withTimezone: true }),
    enrichedAt: timestamp('enriched_at', { withTimezone: true }),
    enrichFailed: boolean('enrich_failed').notNull().default(false),
    enrichAttempts: integer('enrich_attempts').notNull().default(0),
    // Version du schéma d'enrichissement. Permet de repasser sur les jeux
    // déjà traités quand on ajoute de nouveaux champs (date, avis, modes…),
    // sans toucher aux jeux déjà à jour.
    enrichVersion: integer('enrich_version').notNull().default(0),
    /**
     * Réclamation temporaire par un worker.
     *
     * Le cron et un appel manuel peuvent tourner en même temps : sans cette
     * marque, les deux traitent les mêmes jeux et doublent les appels aux API
     * externes. La marque expire au bout de quelques minutes si le worker meurt.
     */
    enrichClaimedAt: timestamp('enrich_claimed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byPending: index('game_cache_pending_idx').on(t.enrichedAt),
  }),
);

/**
 * Préférences de notification d'un membre.
 *
 * Aujourd'hui : les rappels de sortie (« ce jeu de ta wishlist sort
 * aujourd'hui »), envoyés dans un salon Discord à l'heure configurée.
 */
export const notificationPrefs = pgTable('notification_prefs', {
  discordId: text('discord_id')
    .primaryKey()
    .references(() => discordUsers.discordId, { onDelete: 'cascade' }),
  releaseReminders: boolean('release_reminders').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Rappels déjà envoyés.
 *
 * La clé (appid, membre, jour) rend l'envoi idempotent : si le batch tourne
 * deux fois, personne ne reçoit deux fois la même annonce.
 */
export const releaseNotifications = pgTable(
  'release_notifications',
  {
    appid: integer('appid').notNull(),
    discordId: text('discord_id').notNull(),
    /** Jour concerné (YYYY-MM-DD). */
    releaseDate: text('release_date').notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.appid, t.discordId, t.releaseDate] }),
  }),
);

/**
 * Chaîne Twitch d'un membre.
 *
 * Le live n'est pas stocké : il change trop vite. On garde seulement le lien,
 * et le statut est interrogé avec un cache court côté serveur.
 */
export const twitchLinks = pgTable('twitch_links', {
  discordId: text('discord_id')
    .primaryKey()
    .references(() => discordUsers.discordId, { onDelete: 'cascade' }),
  /** Identifiant de la chaîne, en minuscules (celui utilisé dans l'URL). */
  login: text('login').notNull(),
  displayName: text('display_name'),
  avatarUrl: text('avatar_url'),
  linkedAt: timestamp('linked_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Réglages de l'application (une seule ligne).
 *
 * La tâche qui rafraîchit les ludothèques Steam tourne toutes les 15 minutes
 * côté Netlify, mais ne travaille que si l'intervalle configuré ici est écoulé :
 * c'est ce qui rend la fréquence réglable depuis la page admin.
 */
export const appSettings = pgTable('app_settings', {
  id: text('id').primaryKey(),
  /** Rafraîchissement automatique des ludothèques Steam. */
  steamSyncEnabled: boolean('steam_sync_enabled').notNull().default(true),
  /** Intervalle en heures entre deux passages réels (1 à 168). */
  steamSyncIntervalHours: integer('steam_sync_interval_hours').notNull().default(1),
  lastSteamSyncAt: timestamp('last_steam_sync_at', { withTimezone: true }),
  /** Résumé lisible du dernier passage (comptes traités, erreurs). */
  lastSteamSyncResult: text('last_steam_sync_result'),

  /** Page « Recommandations » visible (masquée par défaut, en chantier). */
  recommendationsEnabled: boolean('recommendations_enabled').notNull().default(false),

  /** Rappels Discord des sorties de jeux. */
  releaseNotifyEnabled: boolean('release_notify_enabled').notNull().default(false),
  /** Heure d'envoi (0-23, heure de Paris). */
  releaseNotifyHour: integer('release_notify_hour').notNull().default(6),
  /** Salon Discord cible ; vide = recherche du salon nommé « games ». */
  releaseChannelId: text('release_channel_id'),
  /**
   * Page « Sorties » consultable sans être connecté. Les visiteurs ne voient
   * que le nombre de membres intéressés, jamais les pseudos.
   */
  releasePublicPage: boolean('release_public_page').notNull().default(true),
  lastReleaseNotifyAt: timestamp('last_release_notify_at', { withTimezone: true }),

  /** Récap' du groupe : l'image publiée sur le site (activée par défaut). */
  recapEnabled: boolean('recap_enabled').notNull().default(true),
  /** Fenêtre d'analyse, en jours (1 à 30). */
  recapDays: integer('recap_days').notNull().default(7),
  /** Fréquence de régénération, en heures (1 à 168). */
  recapRefreshHours: integer('recap_refresh_hours').notNull().default(24),
  /** Heure de régénération quand la fréquence est quotidienne (0-23, Paris). */
  recapHour: integer('recap_hour').notNull().default(6),
  lastRecapAt: timestamp('last_recap_at', { withTimezone: true }),
  /**
   * Page du récap' consultable SANS être connecté (les pseudos y sont alors
   * remplacés par « x joueurs »).
   */
  recapPublicPage: boolean('recap_public_page').notNull().default(true),
  /** Afficher les pseudos des joueurs (site + image) ou seulement le nombre. */
  recapShowNames: boolean('recap_show_names').notNull().default(true),
  /** Salon Discord où le bot publie l'image (null = pas de publication). */
  recapChannelId: text('recap_channel_id'),
  /** Message à éditer au lieu d'en renvoyer un nouveau. */
  recapMessageId: text('recap_message_id'),
});

/**
 * État des synchronisations périodiques.
 *
 * Une ligne unique : elle porte la date de la dernière synchronisation des
 * événements, y compris quand Discord n'en renvoie AUCUN. Sans elle, `max(synced_at)`
 * sur `discord_events` vaut NULL dès que la liste est vide et chaque appel à
 * /api/events redéclenche un appel Discord — jusqu'au 429.
 */
export const syncState = pgTable('sync_state', {
  id: text('id').primaryKey(),
  eventsSyncedAt: timestamp('events_synced_at', { withTimezone: true }),
});

/** File d'attente d'enrichissement. */
export const enrichQueue = pgTable(
  'enrich_queue',
  {
    appid: integer('appid').primaryKey(),
    priority: integer('priority').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byPriority: index('enrich_queue_prio_idx').on(t.priority, t.createdAt),
  }),
);

/**
 * Historique du temps de jeu, une ligne par compte Steam, jeu et jour.
 *
 * POURQUOI CETTE TABLE : Steam ne fournit que `playtime_forever` (cumul) et
 * `playtime_2weeks` (14 derniers jours, pas 7). Pour savoir ce qui a été joué
 * sur une fenêtre de N jours — et pas seulement depuis toujours — il faut
 * relever le cumul régulièrement et calculer la différence. C'est le seul
 * moyen honnête d'afficher « les plus joués des 7 derniers jours ».
 *
 * `minutes_min` = première valeur vue dans la journée, `minutes_max` = dernière.
 * La différence entre les deux indique qu'un jeu a tourné ce jour-là.
 */
export const playtimeDaily = pgTable(
  'playtime_daily',
  {
    /** Compte Steam réellement synchronisé (principal ou secondaire). */
    steamid: text('steamid').notNull(),
    appid: integer('appid').notNull(),
    /** Jour (fuseau de Paris), exposé en YYYY-MM-DD par drizzle. */
    day: date('day').notNull(),
    minutesMin: integer('minutes_min').notNull().default(0),
    minutesMax: integer('minutes_max').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.steamid, t.appid, t.day] }),
    byDay: index('playtime_daily_day_idx').on(t.day),
  }),
);

/**
 * Image du récap' du groupe, prête à être affichée (SVG).
 *
 * Elle est régénérée par une tâche planifiée et servie telle quelle : la
 * construire à chaque visite coûterait une agrégation SQL et le téléchargement
 * des jaquettes Steam pour chaque visiteur.
 */
export const recapImages = pgTable('recap_images', {
  /** Une seule ligne : 'default'. */
  id: text('id').primaryKey(),
  svg: text('svg').notNull(),
  /** Fenêtre utilisée pour cette image (jours). */
  windowDays: integer('window_days').notNull().default(7),
  /** 'measured' (snapshots) ou 'estimated' (dérivé de playtime_2weeks). */
  mode: text('mode').notNull().default('measured'),
  /** Données chiffrées ayant servi à l'image (réutilisées par la page). */
  stats: jsonb('stats').$type<unknown>().notNull().default({}),
  /**
   * Variante SANS pseudos, servie sur `/api/recap/image?variant=public` :
   * image partageable hors du serveur (la page du site, elle, n'affiche plus
   * l'image). NULL quand les pseudos sont déjà masqués dans `svg` : une seule
   * variante suffit alors.
   */
  svgPublic: text('svg_public'),
  /** Les pseudos ont-ils été inclus dans `svg` ? */
  showNames: boolean('show_names').notNull().default(true),
  generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Comptes GOG / Epic reliés par un membre.
 *
 * DIFFÉRENCE AVEC STEAM : Steam s'authentifie avec une clé d'API en lecture
 * seule, sans compte utilisateur. GOG et Epic, eux, n'ont pas d'API publique :
 * on passe par l'OAuth de leurs clients officiels (Galaxy, launcher Epic), ce
 * qui produit un couple access/refresh token — donc des secrets de compte,
 * stockés CHIFFRÉS (lib/crypto.ts) et jamais renvoyés au navigateur.
 *
 * `accountId` est l'identifiant chez la plateforme (userId GOG, account_id
 * Epic). Un membre peut en relier plusieurs par plateforme (comptes
 * secondaires, comptes de proches).
 */
export const externalAccounts = pgTable(
  'external_accounts',
  {
    /** `${discordId}:${platform}:${accountId}` — clé stable. */
    id: text('id').primaryKey(),
    discordId: text('discord_id').notNull(),
    /** 'gog' ou 'epic'. */
    platform: text('platform').notNull(),
    accountId: text('account_id').notNull(),
    displayName: text('display_name'),
    avatarUrl: text('avatar_url'),
    profileUrl: text('profile_url'),
    /** Jetons chiffrés (AES-256-GCM) : la base ne contient pas de clair. */
    accessTokenEnc: text('access_token_enc'),
    refreshTokenEnc: text('refresh_token_enc'),
    tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
    gamesCount: integer('games_count').notNull().default(0),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byMember: index('external_accounts_member_idx').on(t.discordId),
  }),
);

/**
 * Jeux d'un compte GOG / Epic.
 *
 * On ne les met PAS dans `owned_games` : la clé de cette table est
 * (steamid, appid) et un produit GOG/Epic n'a pas d'appid Steam. Les garder
 * séparés évite de polluer les totaux Steam — le rapprochement
 * inter-plateformes, lui, se fera par titre en lecture.
 */
export const externalGames = pgTable(
  'external_games',
  {
    accountRowId: text('account_row_id').notNull(),
    /** Identifiant chez la plateforme : id produit GOG, appName Epic. */
    externalId: text('external_id').notNull(),
    name: text('name').notNull(),
    imageUrl: text('image_url'),
    /** Temps de jeu total en minutes (0 quand la plateforme ne le donne pas). */
    minutes: integer('minutes').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.accountRowId, t.externalId] }),
  }),
);

export type DiscordUser = typeof discordUsers.$inferSelect;
export type SteamLink = typeof steamLinks.$inferSelect;
export type User = typeof users.$inferSelect;
export type OwnedGame = typeof ownedGames.$inferSelect;
export type WishlistItem = typeof wishlistItems.$inferSelect;
export type DiscordEvent = typeof discordEvents.$inferSelect;
export type GameCacheRow = typeof gameCache.$inferSelect;
export type Session = typeof sessions.$inferSelect;
