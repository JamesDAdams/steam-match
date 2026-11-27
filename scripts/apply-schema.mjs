/**
 * Applique le schéma d'identité Discord.
 *
 * POURQUOI CE SCRIPT PLUTÔT QUE `drizzle-kit push` :
 * drizzle-kit pose une question interactive (« renommer ou créer ? ») quand
 * une colonne change de nom, ce qui bloque en mode non interactif. Comme la
 * base ne contient encore aucune donnée métier, on applique le SQL directement,
 * de façon idempotente et rejouable.
 *
 * Usage : node scripts/apply-schema.mjs
 */
import fs from 'node:fs';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { sql as sqlTag } from 'drizzle-orm';

const envFile = '.env.local';
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL manquant.');
  process.exit(1);
}

const db = drizzle(neon(process.env.DATABASE_URL));

const statements = [
  // ── Comptes Discord ────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS discord_users (
     discord_id   text PRIMARY KEY NOT NULL,
     username     text NOT NULL,
     global_name  text,
     avatar_url   text,
     is_admin     boolean NOT NULL DEFAULT false,
     last_login_at timestamp with time zone,
     created_at   timestamp with time zone NOT NULL DEFAULT now()
   )`,

  // Appartenance au serveur Discord (vérifiée via le bot).
  `ALTER TABLE discord_users ADD COLUMN IF NOT EXISTS is_member boolean NOT NULL DEFAULT false`,
  `ALTER TABLE discord_users ADD COLUMN IF NOT EXISTS member_checked_at timestamp with time zone`,

  // ── Whitelist ──────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS allowed_discord_ids (
     discord_id text PRIMARY KEY NOT NULL,
     note       text,
     added_by   text,
     created_at timestamp with time zone NOT NULL DEFAULT now()
   )`,

  // ── Liaison Discord ↔ Steam ────────────────────────────────────────
  // steamid UNIQUE : un compte Steam ne peut appartenir qu'à un Discord.
  `CREATE TABLE IF NOT EXISTS steam_links (
     discord_id text PRIMARY KEY NOT NULL
       REFERENCES discord_users(discord_id) ON DELETE CASCADE,
     steamid    text NOT NULL UNIQUE
       REFERENCES users(steamid) ON DELETE CASCADE,
     linked_at  timestamp with time zone NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS steam_links_steam_idx ON steam_links (steamid)`,

  // ── Wishlist Steam ─────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS wishlist_items (
     steamid    text NOT NULL REFERENCES users(steamid) ON DELETE CASCADE,
     appid      integer NOT NULL,
     priority   integer NOT NULL DEFAULT 0,
     updated_at timestamp with time zone NOT NULL DEFAULT now(),
     PRIMARY KEY (steamid, appid)
   )`,
  `CREATE INDEX IF NOT EXISTS wishlist_items_app_idx ON wishlist_items (appid)`,

  // ── Événements Discord ─────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS discord_events (
     id                 text PRIMARY KEY NOT NULL,
     guild_id           text NOT NULL,
     name               text NOT NULL,
     description        text,
     status             integer NOT NULL DEFAULT 1,
     entity_type        integer NOT NULL DEFAULT 3,
     location           text,
     cover_image        text,
     interested_count   integer NOT NULL DEFAULT 0,
     scheduled_start_at timestamp with time zone NOT NULL,
     scheduled_end_at   timestamp with time zone,
     synced_at          timestamp with time zone NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS discord_events_start_idx ON discord_events (scheduled_start_at)`,

  // ── État des synchronisations ──────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS sync_state (
     id                text PRIMARY KEY NOT NULL,
     events_synced_at  timestamp with time zone
   )`,

  // ── Notifications (rappels de sortie) ──────────────────────────────
  `CREATE TABLE IF NOT EXISTS notification_prefs (
     discord_id        text PRIMARY KEY NOT NULL
       REFERENCES discord_users(discord_id) ON DELETE CASCADE,
     release_reminders boolean NOT NULL DEFAULT false,
     updated_at        timestamp with time zone NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS release_notifications (
     appid        integer NOT NULL,
     discord_id   text NOT NULL,
     release_date text NOT NULL,
     sent_at      timestamp with time zone NOT NULL DEFAULT now(),
     PRIMARY KEY (appid, discord_id, release_date)
   )`,
  `ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS recommendations_enabled boolean NOT NULL DEFAULT false`,
  `ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS release_notify_enabled boolean NOT NULL DEFAULT false`,
  `ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS release_notify_hour integer NOT NULL DEFAULT 6`,
  `ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS release_channel_id text`,
  `ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS last_release_notify_at timestamp with time zone`,

  // ── Chaînes Twitch des membres ─────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS twitch_links (
     discord_id   text PRIMARY KEY NOT NULL
       REFERENCES discord_users(discord_id) ON DELETE CASCADE,
     login        text NOT NULL,
     display_name text,
     avatar_url   text,
     linked_at    timestamp with time zone NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS twitch_links_login_idx ON twitch_links (login)`,

  // ── Réglages de l'application ──────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS app_settings (
     id                        text PRIMARY KEY NOT NULL,
     steam_sync_enabled        boolean NOT NULL DEFAULT true,
     steam_sync_interval_hours integer NOT NULL DEFAULT 1,
     last_steam_sync_at        timestamp with time zone,
     last_steam_sync_result    text
   )`,

  // ── Comptes Steam supplémentaires (secondaire / famille) ───────────
  `CREATE TABLE IF NOT EXISTS steam_accounts (
     owner_steamid  text NOT NULL REFERENCES users(steamid) ON DELETE CASCADE,
     steamid        text NOT NULL,
     kind           text NOT NULL DEFAULT 'family',
     persona_name   text,
     avatar_url     text,
     games_count    integer NOT NULL DEFAULT 0,
     last_synced_at timestamp with time zone,
     last_error     text,
     created_at     timestamp with time zone NOT NULL DEFAULT now(),
     PRIMARY KEY (owner_steamid, steamid)
   )`,
  `ALTER TABLE owned_games ADD COLUMN IF NOT EXISTS source_steamid text`,
  `ALTER TABLE wishlist_items ADD COLUMN IF NOT EXISTS source_steamid text`,

  // ── Jeux partagés par la famille Steam ─────────────────────────────
  // GetOwnedGames ne renvoie jamais les jeux empruntés à un groupe familial :
  // ils sont donc ajoutés à la main et marqués, pour survivre aux synchros.
  `ALTER TABLE owned_games ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'owned'`,

  // ── Dernier lancement connu (récap' des jeux joués) ────────────────
  `ALTER TABLE owned_games ADD COLUMN IF NOT EXISTS last_played_at timestamp with time zone`,

  // ── Récap' du groupe (image publiée) ───────────────────────────────
  // Historique quotidien du temps de jeu : Steam ne donne que le cumul et
  // les 14 derniers jours, donc on relève le cumul pour pouvoir mesurer une
  // fenêtre de N jours.
  `CREATE TABLE IF NOT EXISTS playtime_daily (
     steamid   text NOT NULL,
     appid     integer NOT NULL,
     day       date NOT NULL,
     minutes_min integer NOT NULL DEFAULT 0,
     minutes_max integer NOT NULL DEFAULT 0,
     updated_at  timestamp with time zone NOT NULL DEFAULT now(),
     PRIMARY KEY (steamid, appid, day)
   )`,
  `CREATE INDEX IF NOT EXISTS playtime_daily_day_idx ON playtime_daily (day)`,

  // ── Comptes GOG / Epic ─────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS external_accounts (
     id text PRIMARY KEY NOT NULL,
     discord_id text NOT NULL,
     platform text NOT NULL,
     account_id text NOT NULL,
     display_name text,
     avatar_url text,
     profile_url text,
     access_token_enc text,
     refresh_token_enc text,
     token_expires_at timestamp with time zone,
     games_count integer NOT NULL DEFAULT 0,
     last_synced_at timestamp with time zone,
     last_error text,
     created_at timestamp with time zone NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS external_accounts_member_idx ON external_accounts (discord_id)`,

  `CREATE TABLE IF NOT EXISTS external_games (
     account_row_id text NOT NULL,
     external_id text NOT NULL,
     name text NOT NULL,
     image_url text,
     minutes integer NOT NULL DEFAULT 0,
     updated_at timestamp with time zone NOT NULL DEFAULT now(),
     PRIMARY KEY (account_row_id, external_id)
   )`,

  `CREATE TABLE IF NOT EXISTS recap_images (
     id          text PRIMARY KEY NOT NULL,
     svg         text NOT NULL,
     window_days integer NOT NULL DEFAULT 7,
     mode        text NOT NULL DEFAULT 'measured',
     stats       jsonb NOT NULL DEFAULT '{}'::jsonb,
     generated_at timestamp with time zone NOT NULL DEFAULT now()
   )`,

  `ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS recap_enabled boolean NOT NULL DEFAULT true`,
  `ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS recap_days integer NOT NULL DEFAULT 7`,
  `ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS recap_refresh_hours integer NOT NULL DEFAULT 24`,
  `ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS recap_hour integer NOT NULL DEFAULT 6`,
  `ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS last_recap_at timestamp with time zone`,
  `ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS recap_channel_id text`,
  `ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS recap_message_id text`,
  `ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS release_public_page boolean NOT NULL DEFAULT true`,
  `ALTER TABLE discord_users ADD COLUMN IF NOT EXISTS games_public boolean NOT NULL DEFAULT false`,
  `ALTER TABLE discord_users ADD COLUMN IF NOT EXISTS profile_public boolean NOT NULL DEFAULT false`,
  `ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS recap_public_page boolean NOT NULL DEFAULT true`,
  `ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS recap_show_names boolean NOT NULL DEFAULT true`,
  `ALTER TABLE recap_images ADD COLUMN IF NOT EXISTS svg_public text`,
  `ALTER TABLE recap_images ADD COLUMN IF NOT EXISTS show_names boolean NOT NULL DEFAULT true`,

  // ── Intéressés des événements Discord ──────────────────────────────
  `ALTER TABLE discord_events ADD COLUMN IF NOT EXISTS interested_users jsonb NOT NULL DEFAULT '[]'::jsonb`,
  `ALTER TABLE discord_events ADD COLUMN IF NOT EXISTS interested_synced_at timestamp with time zone`,
  `ALTER TABLE discord_events ADD COLUMN IF NOT EXISTS site_interested_users jsonb NOT NULL DEFAULT '[]'::jsonb`,
  `ALTER TABLE discord_events ADD COLUMN IF NOT EXISTS maybe_users jsonb NOT NULL DEFAULT '[]'::jsonb`,

  // ── Annonce Discord des événements créés depuis le site ────────────
  `ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS event_announce_channel_id text`,
  `ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS discord_verify_key text`,
  `ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS last_interaction_at timestamp with time zone`,
  `ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS last_interaction_kind text`,
  `ALTER TABLE discord_events ADD COLUMN IF NOT EXISTS game_appid integer`,
  `ALTER TABLE discord_events ADD COLUMN IF NOT EXISTS announce_message_id text`,
  `ALTER TABLE discord_events ADD COLUMN IF NOT EXISTS announce_channel_id text`,
  `ALTER TABLE discord_events ADD COLUMN IF NOT EXISTS channel_id text`,
  `ALTER TABLE discord_events ADD COLUMN IF NOT EXISTS channel_name text`,
  `ALTER TABLE discord_events ADD COLUMN IF NOT EXISTS description_dirty boolean NOT NULL DEFAULT false`,

  // ── Prix des jeux (colonnes ajoutées après coup) ───────────────────
  `ALTER TABLE game_cache ADD COLUMN IF NOT EXISTS cheapest_price integer`,
  `ALTER TABLE game_cache ADD COLUMN IF NOT EXISTS cheapest_store text`,
  `ALTER TABLE game_cache ADD COLUMN IF NOT EXISTS price_updated_at timestamp with time zone`,
  `ALTER TABLE game_cache ADD COLUMN IF NOT EXISTS cheapest_currency text`,
  `ALTER TABLE game_cache ADD COLUMN IF NOT EXISTS steam_price integer`,
  `ALTER TABLE game_cache ADD COLUMN IF NOT EXISTS steam_initial_price integer`,
  `ALTER TABLE game_cache ADD COLUMN IF NOT EXISTS steam_discount integer`,
  `ALTER TABLE game_cache ADD COLUMN IF NOT EXISTS steam_currency text`,
  `ALTER TABLE game_cache ADD COLUMN IF NOT EXISTS review_positive integer`,
  `ALTER TABLE game_cache ADD COLUMN IF NOT EXISTS review_negative integer`,
  `ALTER TABLE game_cache ADD COLUMN IF NOT EXISTS review_score integer`,
  `ALTER TABLE game_cache ADD COLUMN IF NOT EXISTS release_date text`,
  `ALTER TABLE game_cache ADD COLUMN IF NOT EXISTS play_modes jsonb NOT NULL DEFAULT '[]'::jsonb`,
  `ALTER TABLE game_cache ADD COLUMN IF NOT EXISTS enrich_version integer NOT NULL DEFAULT 0`,
  `ALTER TABLE game_cache ADD COLUMN IF NOT EXISTS enrich_claimed_at timestamp with time zone`,

  // ── Jeux vs logiciels ──────────────────────────────────────────────
  // Un utilitaire (Lossless Scaling, CINEVR…) n'a rien à faire dans les
  // listes de jeux. Steam le déclare parfois « game », d'où le calcul par
  // genre : utilitaire ET aucun genre de jeu (voir lib/software.ts).
  `ALTER TABLE game_cache ADD COLUMN IF NOT EXISTS app_type text`,
  `ALTER TABLE game_cache ADD COLUMN IF NOT EXISTS is_software boolean NOT NULL DEFAULT false`,
  `UPDATE game_cache SET is_software = COALESCE((
     app_type = 'software'
     OR (
       EXISTS (
         SELECT 1 FROM jsonb_array_elements_text(genres) g
         WHERE lower(g) IN (
           'utilities','utilitaires','software training','formation logicielle',
           'animation & modeling','animation et modélisation','audio production',
           'production audio','design & illustration','conception et illustration',
           'photo editing','édition de photos','video production','production vidéo',
           'web publishing','édition web','accounting','comptabilité',
           'education','éducation'
         )
       )
       AND NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements_text(genres) g
         WHERE lower(g) IN (
           'action','adventure','aventure','rpg','strategy','stratégie','simulation',
           'casual','occasionnel','indie','indépendant','racing','course','sports',
           'sport','massively multiplayer','massivement multijoueur',
           'violent','gore','sexual content','contenu sexuel'
         )
       )
     )
   ), false)`,

  // ── Sessions ─────────────────────────────────────────────��─────────
  // NON destructif : on ne supprime jamais la table, sinon tous les membres
  // connectés seraient déconnectés à chaque migration.
  `CREATE TABLE IF NOT EXISTS sessions (
     token       text PRIMARY KEY NOT NULL,
     discord_id  text NOT NULL
       REFERENCES discord_users(discord_id) ON DELETE CASCADE,
     expires_at  timestamp with time zone NOT NULL,
     created_at  timestamp with time zone NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS sessions_discord_idx ON sessions (discord_id)`,
];

for (const [i, stmt] of statements.entries()) {
  const label = stmt.trim().split('\n')[0].slice(0, 70);
  try {
    // sql.raw : SQL dynamique déjà construit, donc pas d'interpolation ici.
    await db.execute(sqlTag.raw(stmt));
    console.log(`  ✓ ${i + 1}/${statements.length} ${label}`);
  } catch (err) {
    console.error(`  ✗ ${i + 1}/${statements.length} ${label}`);
    console.error('    ' + err.message);
    process.exit(1);
  }
}

console.log('\n[apply-schema] schéma Discord appliqué.');
