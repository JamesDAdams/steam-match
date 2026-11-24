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
  '/src/views/LoginView.vue',
  '/src/views/CommonView.vue',
  '/src/views/RecommendView.vue',
  '/src/views/HelpView.vue',
  '/src/views/AdminView.vue',
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
        { path: '/aide', component: { template: '<div />' } },
        { path: '/admin', component: { template: '<div />' } },
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

await vite.close();
console.log(failures === 0 ? '\nToutes les vues se rendent.' : `\n${failures} vue(s) en échec.`);
process.exit(failures === 0 ? 0 : 1);
