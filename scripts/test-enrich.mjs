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

  // Appid optionnel en argument : node scripts/test-enrich.mjs 1091500
  const appid = Number(process.argv[2] ?? 16900);

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

  console.log('\n=== PRIX STEAM (officiel, EUR) ===');
  const sp = await prices.fetchSteamPrice(appid);
  if (sp) {
    console.log(`  actuel  : ${prices.formatPrice(sp.priceCents, sp.currency)}`);
    console.log(`  de base : ${prices.formatPrice(sp.initialCents, sp.currency)}`);
    console.log(`  remise  : ${sp.discountPercent}%`);
  } else {
    console.log('  (jeu gratuit ou prix indisponible)');
  }

  console.log('\n=== PRIX EN CLÉ ===');
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
    console.log('  ⚠ aucune offre chez un revendeur de clés (jeu absent des');
    console.log('    boutiques tierces, ou vendu uniquement sur Steam)');
  }

  // Avec un appid explicite, on ne touche pas à la file d'attente.
  if (process.argv[2]) {
    console.log('\n(appid fourni : lot d’enrichissement non exécuté)');
    await vite.close();
    process.exit(process.exitCode ?? 0);
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
