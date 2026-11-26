/**
 * Vérifie que la fonction catch-all et tous ses handlers s'importent.
 *
 * POURQUOI : `tsc` ne voyait pas `lib/` ni `netlify/` (tsconfig), et une simple
 * déclaration en double dans un handler passait donc inaperçue — jusqu'à ce que
 * Netlify n'arrive plus à empaqueter la fonction et serve des 502 sur TOUTE
 * l'API. Ce script charge réellement le point d'entrée : une erreur de syntaxe
 * ou un import cassé est détecté avant le déploiement.
 *
 * Usage : node scripts/check-functions.mjs
 */
import { pathToFileURL } from 'node:url';

const FILES = [
  'netlify/functions/api.ts',
  'netlify/functions/enrich-cron.ts',
  'lib/handlers/events.ts',
  'lib/handlers/events-create.ts',
  'lib/handlers/events-delete.ts',
  'lib/handlers/events-channels.ts',
  'lib/handlers/events-game-search.ts',
  'lib/handlers/events-game-info.ts',
  'lib/handlers/steam-accounts.ts',
  'lib/handlers/admin-settings.ts',
  'lib/handlers/twitch.ts',
  'lib/handlers/members.ts',
  'lib/handlers/releases.ts',
  'lib/handlers/notifications.ts',
  'netlify/functions/release-cron.ts',
  'lib/handlers/recap.ts',
  'lib/handlers/recap-image.ts',
  'netlify/functions/recap-cron.ts',
  'netlify/functions/steam-sync-cron.ts',
];

let failures = 0;

for (const file of FILES) {
  try {
    const mod = await import(pathToFileURL(file).href);
    const exported = mod.default ?? mod.handler;
    if (typeof exported !== 'function') {
      console.error(`  ✗ ${file} — aucun handler exporté`);
      failures++;
      continue;
    }
    console.log(`  ✓ ${file}`);
  } catch (err) {
    console.error(`  ✗ ${file} — ${err.message}`);
    failures++;
  }
}

if (failures > 0) {
  console.error(`\n${failures} fichier(s) en échec.`);
  process.exit(1);
}

console.log('\nToutes les fonctions se chargent.');
