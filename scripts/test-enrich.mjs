/**
 * Teste l'enrichissement automatique en conditions réelles.
 *
 * Vérifie les deux fournisseurs (SteamSpy pour les métadonnées, CheapShark
 * pour les prix) puis traite un petit lot de la file d'attente.
 *
 * Usage : node scripts/test-enrich.mjs
 */
import fs from 'node:fs';
import { createServer } from 'vite';

const envFile = '.env.local';
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL manquant.');
  process.exit(1);
}

const vite = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
});

try {
  const meta = await vite.ssrLoadModule('/lib/metadata.ts');
  const prices = await vite.ssrLoadModule('/lib/prices.ts');

  const appid = 16900; // GROUND BRANCH, présent en wishlist

  console.log('\n=== METADONNEES (SteamSpy puis Store) ===');
  const m = await meta.fetchMetadata(appid);
  if (m) {
    console.log(`  nom     : ${m.name}`);
    console.log(`  genres  : ${m.genres.join(', ') || '(aucun)'}`);
    console.log(`  tags    : ${m.tags.slice(0, 6).join(', ') || '(aucun)'}`);
    console.log(`  source  : ${m.source}`);
    console.log('  ✓ métadonnées récupérées');
  } else {
    console.error('  ✗ aucune métadonnée');
    process.exitCode = 1;
  }

  console.log('\n=== PRIX ===');
  const p = await prices.fetchCheapestPrice(appid);
  if (p) {
    console.log(`  prix    : ${prices.formatPrice(p.priceCents, p.currency)}`);
    console.log(`  boutique: ${p.store}`);
    console.log(`  devise  : ${p.currency}`);
    console.log(
      `  source  : ${process.env.GG_DEALS_API_KEY ? 'GG.deals (clé configurée)' : 'CheapShark (sans clé)'}`,
    );
    console.log('  ✓ prix récupéré');
  } else {
    console.log('  ⚠ aucun prix (le jeu peut être absent du comparateur)');
  }

  console.log('\n=== LOT D ENRICHISSEMENT ===');
  const worker = await vite.ssrLoadModule('/lib/enrich-worker.ts');
  const r = await worker.runEnrichBatch(3, true);
  console.log(`  traités : ${r.processed}`);
  console.log(`  enrichis: ${r.enriched}`);
  console.log(`  différés: ${r.deferred}`);
  console.log(`  restants: ${r.remaining}`);
} catch (err) {
  console.error('\n  ✗ ÉCHEC :', err.message);
  process.exitCode = 1;
} finally {
  await vite.close();
}
