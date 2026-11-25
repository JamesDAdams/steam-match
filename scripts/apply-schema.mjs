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

  // ── Prix des jeux (colonnes ajoutées après coup) ───────────────────
  `ALTER TABLE game_cache ADD COLUMN IF NOT EXISTS cheapest_price integer`,
  `ALTER TABLE game_cache ADD COLUMN IF NOT EXISTS cheapest_store text`,
  `ALTER TABLE game_cache ADD COLUMN IF NOT EXISTS price_updated_at timestamp with time zone`,
  `ALTER TABLE game_cache ADD COLUMN IF NOT EXISTS cheapest_currency text`,
  `ALTER TABLE game_cache ADD COLUMN IF NOT EXISTS steam_price integer`,
  `ALTER TABLE game_cache ADD COLUMN IF NOT EXISTS steam_initial_price integer`,
  `ALTER TABLE game_cache ADD COLUMN IF NOT EXISTS steam_discount integer`,
  `ALTER TABLE game_cache ADD COLUMN IF NOT EXISTS steam_currency text`,

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
