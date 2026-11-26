/**
 * Vérifie que chaque vue se rend sans erreur, en SSR.
 *
 * POURQUOI : une variable de template non déclarée (ex. `m` hors d'un v-for)
 * ne casse pas la compilation — Vue plante au rendu, et la page devient
 * blanche. Ce script rend chaque composant côté serveur et rapporte l'erreur
 * exacte, ce qui évite de déboguer à l'aveugle dans le navigateur.
 *
 * Usage : node scripts/render-check.mjs
 */
import { createServer } from 'vite';
// Toutes les instances du runtime viennent du même graphe (imports statiques),
// sinon les symboles d'injection de vue-router ne correspondent pas à ceux de
// vue et useRoute() échoue artificiellement.
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { createRouter, createMemoryHistory } from 'vue-router';

const FILES = [
  '/src/App.vue',
  '/src/components/EventCreateModal.vue',
  '/src/components/EventInterested.vue',
  '/src/views/LoginView.vue',
  '/src/views/ProfileView.vue',
  '/src/views/EventsView.vue',
  '/src/views/CommonView.vue',
  '/src/views/RecommendView.vue',
  '/src/views/AdminView.vue',
  '/src/views/TwitchView.vue',
  '/src/views/MembersView.vue',
  '/src/views/ReleasesView.vue',
  '/src/views/MemberView.vue',
  '/src/views/RecapView.vue',
];

const vite = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
});



let failures = 0;

for (const file of FILES) {
  try {
    const mod = await vite.ssrLoadModule(file);
    const app = createSSRApp(mod.default);

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', component: { template: '<div />' } },
        { path: '/commun', component: { template: '<div />' } },
        { path: '/recommandations', component: { template: '<div />' } },
        { path: '/admin', component: { template: '<div />' } },
        { path: '/twitch', component: { template: '<div />' } },
        { path: '/membres', component: { template: '<div />' } },
        { path: '/sorties', component: { template: '<div />' } },
        { path: '/membres/:discordId', component: { template: '<div />' } },
      ],
    });
    await router.push('/');
    await router.isReady();
    app.use(router);

    const html = await renderToString(app);
    console.log(`  ✓ ${file.padEnd(34)} ${String(html.length).padStart(6)} octets rendus`);
  } catch (err) {
    failures++;
    console.error(`  ✗ ${file}`);
    console.error(`    ${err.message.split('\n')[0]}`);
    if (err.stack) {
      const line = err.stack.split('\n').find((l) => l.includes('.vue'));
      if (line) console.error(`    ${line.trim()}`);
    }
  }
}

// ── Contrôle statique : une vue qui démarre en `loading = true` doit
//    déclencher son chargement, sinon elle affiche ses squelettes à vie.
//    Le rendu SSR ne peut pas le détecter : onMounted ne s'y exécute pas.
console.log('\n  — Initialisation des chargements —');
for (const file of FILES) {
  let src = '';
  try {
    src = await (await import('node:fs/promises')).readFile(
      new URL(`..${file}`, import.meta.url),
      'utf8',
    );
  } catch {
    continue;
  }
  const startsLoading = /const loading = ref\(true\)/.test(src);
  const triggersLoad = /onMounted\(/.test(src);
  if (startsLoading && !triggersLoad) {
    failures++;
    console.error(`  ✗ ${file} : loading démarre à true mais aucun onMounted()`);
  } else if (startsLoading) {
    console.log(`  ✓ ${file.replace('/src/', '')} déclenche son chargement`);
  }
}

await vite.close();
console.log(failures === 0 ? '\nToutes les vues se rendent.' : `\n${failures} vue(s) en échec.`);
process.exit(failures === 0 ? 0 : 1);
