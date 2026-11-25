/**
 * Teste la fonction catch-all Netlify sans déployer.
 *
 * Simule des HandlerEvent (le format que Netlify passe aux fonctions) et
 * vérifie le routage, l'adaptateur et les codes de retour.
 *
 * Usage : node scripts/test-netlify.mjs
 */
import { createServer } from 'vite';

const vite = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
});

const mod = await vite.ssrLoadModule('/netlify/functions/api.ts');
const handler = mod.handler;

function event(method, url, body = null, query = {}) {
  const u = new URL(url);
  return {
    rawUrl: url,
    path: u.pathname,
    httpMethod: method,
    headers: { host: u.host },
    queryStringParameters: { ...Object.fromEntries(u.searchParams), ...query },
    body,
    isBase64Encoded: false,
  };
}

const cases = [
  ['GET', 'http://localhost/api/me', null, 200],
  ['GET', 'http://localhost/api/group', null, 401],
  ['GET', 'http://localhost/api/common', null, 401],
  ['GET', 'http://localhost/api/common?mode=wishlist', null, 401],
  ['GET', 'http://localhost/api/recommendations', null, 401],
  ['POST', 'http://localhost/api/sync', null, 401],
  ['POST', 'http://localhost/api/enrich', null, 401],
  ['GET', 'http://localhost/api/events', null, 401],
  ['GET', 'http://localhost/api/events/channels', null, 401],
  ['POST', 'http://localhost/api/events/create', null, 401],
  ['POST', 'http://localhost/api/events/delete', null, 401],
  ['GET', 'http://localhost/api/events/delete', null, 405],
  ['GET', 'http://localhost/api/events/create', null, 405],
  ['GET', 'http://localhost/api/auth/steam', null, 302],
  ['GET', 'http://localhost/api/inexistant', null, 404],
  ['DELETE', 'http://localhost/api/me', null, 405],
];

let failures = 0;

for (const [method, url, body, expected] of cases) {
  try {
    const res = await handler(event(method, url, body), {});
    const ok = res.statusCode === expected;
    if (!ok) failures++;
    const label = `${method.padEnd(6)} ${new URL(url).pathname}${new URL(url).search}`;
    console.log(
      `  ${ok ? '✓' : '✗'} ${label.padEnd(42)} ${res.statusCode}` +
        (ok ? '' : `  (attendu ${expected})`),
    );
  } catch (err) {
    failures++;
    console.error(`  ✗ ${method} ${url} → exception : ${err.message}`);
  }
}

// Vérifie la structure d'une réponse JSON réussie.
const me = await handler(event('GET', 'http://localhost/api/me'), {});
const parsed = JSON.parse(me.body);
console.log(
  `\n  /api/me → ${JSON.stringify(parsed)}` +
    (parsed.ok === true && parsed.authenticated === false ? '  ✓' : '  ✗'),
);
if (!(parsed.ok === true && parsed.authenticated === false)) failures++;

// ── Cas spécifique : plusieurs cookies ──
// Netlify refuse un tableau dans headers ; ils doivent partir dans
// multiValueHeaders, sinon le login Discord casse en production.
console.log('\n  — En-têtes à valeurs multiples —');
const res2 = mod.createResponse();
const out = res2
  .setHeader('Set-Cookie', ['sm_session=abc; Path=/', 'sm_oauth_state=def; Path=/api/auth'])
  .status(200)
  .json({ ok: true });

const mv = out.multiValueHeaders?.['set-cookie'];
const inHeaders = out.headers?.['set-cookie'];

if (mv && mv.length === 2) {
  console.log('  ✓ deux cookies placés dans multiValueHeaders');
} else {
  failures++;
  console.error(`  ✗ multiValueHeaders attendu (2 entrées), reçu : ${JSON.stringify(mv)}`);
}

if (inHeaders === undefined) {
  console.log('  ✓ pas de "set-cookie" dans headers (Netlify le refuserait)');
} else {
  failures++;
  console.error(`  ✗ set-cookie ne doit pas être dans headers : ${JSON.stringify(inHeaders)}`);
}

// Les en-têtes simples restent bien dans headers.
const res3 = mod.createResponse();
const out3 = res3.setHeader('Cache-Control', 'no-store').status(200).json({});
if (out3.headers?.['cache-control'] === 'no-store') {
  console.log('  ✓ en-têtes simples conservés dans headers');
} else {
  failures++;
  console.error('  ✗ en-tête simple perdu');
}

await vite.close();
console.log(failures === 0 ? '\nFonction Netlify : OK' : `\n${failures} échec(s)`);
process.exit(failures === 0 ? 0 : 1);
