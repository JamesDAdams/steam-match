/**
 * Inspecte la structure réelle de la base (utile quand drizzle-kit pose
 * une question interactive et qu'on ne sait pas ce qui a été appliqué).
 * Usage : node scripts/inspect-db.mjs
 */
import fs from 'node:fs';
import { neon } from '@neondatabase/serverless';

const envFile = '.env.local';
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL manquant');
  process.exit(1);
}

const sql = neon(process.env.DATABASE_URL);

const tables = await sql`
  select table_name
  from information_schema.tables
  where table_schema = 'public'
  order by table_name
`;

console.log('\n=== TABLES ===');
for (const t of tables) console.log('  ' + t.table_name);

// Aperçu des jeux enrichis avec les nouveaux champs.
if (tables.some((t) => t.table_name === 'game_cache')) {
  const games = await sql`
    select name, release_date, review_score, play_modes,
           steam_price, steam_currency, cheapest_price, cheapest_currency,
           enrich_version
    from game_cache
    where enriched_at is not null
    order by updated_at desc
    limit 5
  `;
  console.log(`\n=== JEUX ENRICHIS (aperçu, ${games.length}) ===`);
  for (const g of games) {
    const prix = [
      g.steam_price ? `Steam ${(g.steam_price / 100).toFixed(2)}${g.steam_currency ?? ''}` : null,
      g.cheapest_price ? `clé ${(g.cheapest_price / 100).toFixed(2)}${g.cheapest_currency ?? ''}` : null,
    ].filter(Boolean).join(' | ');
    console.log(`  ${String(g.name).slice(0, 34).padEnd(36)}`);
    console.log(`     sortie: ${g.release_date ?? '—'} | avis: ${g.review_score != null ? g.review_score + '%' : '—'} | modes: ${(g.play_modes ?? []).join(', ') || '—'}`);
    console.log(`     ${prix || 'aucun prix'} | schéma v${g.enrich_version}`);
  }
}

// Résumé applicatif : état de confidentialité Steam détecté.
if (tables.some((t) => t.table_name === 'users')) {
  const us = await sql`
    select persona_name, profile_visible, games_visible, last_sync_at
    from users order by created_at
  `;
  console.log(`\n=== ETAT STEAM (${us.length}) ===`);
  for (const u of us) {
    console.log(
      `  ${String(u.persona_name).padEnd(20)} profil public: ${
        u.profile_visible ? 'OUI' : 'NON '
      }  temps de jeu: ${u.games_visible ? 'OUI' : 'NON '}  sync: ${
        u.last_sync_at ? 'oui' : 'jamais'
      }`,
    );
  }
}

for (const t of tables) {
  const cols = await sql`
    select column_name, data_type, is_nullable
    from information_schema.columns
    where table_schema = 'public' and table_name = ${t.table_name}
    order by ordinal_position
  `;
  console.log(`\n=== ${t.table_name} ===`);
  for (const c of cols) {
    console.log(`  ${c.column_name.padEnd(22)} ${c.data_type}${c.is_nullable === 'NO' ? ' NOT NULL' : ''}`);
  }
}
