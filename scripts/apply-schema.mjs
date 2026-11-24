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

  // ── Sessions : on repart de zéro (aucune session utile en dev) ─────
  `DROP TABLE IF EXISTS sessions CASCADE`,
  `CREATE TABLE sessions (
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
