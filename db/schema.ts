import {
  pgTable,
  text,
  integer,
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
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.steamid, t.appid] }),
    byApp: index('owned_games_app_idx').on(t.appid),
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

export type DiscordUser = typeof discordUsers.$inferSelect;
export type SteamLink = typeof steamLinks.$inferSelect;
export type User = typeof users.$inferSelect;
export type OwnedGame = typeof ownedGames.$inferSelect;
export type WishlistItem = typeof wishlistItems.$inferSelect;
export type DiscordEvent = typeof discordEvents.$inferSelect;
export type GameCacheRow = typeof gameCache.$inferSelect;
export type Session = typeof sessions.$inferSelect;
