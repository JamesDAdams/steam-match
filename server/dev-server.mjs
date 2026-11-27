/**
 * Serveur de développement local.
 *
 * POURQUOI CE FICHIER :
 * `vercel dev` exige un login Vercel, et les handlers utilisent des imports
 * avec extension .ts que Node ne résout pas nativement. On utilise donc Vite
 * en mode middleware : il compile les .ts et les .vue à la volée, et on lui
 * branche un adaptateur qui donne aux handlers Vercel une interface proche
 * d'Express (req.query, res.status().json(), res.redirect()…).
 *
 * Les handlers restent inchangés : c'est exactement le même code que celui
 * déployé sur Vercel.
 *
 * ORDRE DE ROUTAGE (important) :
 *   1. /api/*        → adaptateur Vercel
 *   2. tout le reste → vite.middlewares (transforme /src/main.ts, HMR, .vue…)
 *   3. fallback      → index.html transformé, pour les routes du SPA (vue-router)
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 3000);

// Charge les variables d'environnement locales si le fichier existe.
const envFile = path.join(root, '.env.local');
if (fs.existsSync(envFile)) {
  process.loadEnvFile(envFile);
  console.log('[dev] variables locales chargées');
} else {
  console.warn('[dev] ATTENTION : aucun fichier .env.local trouvé');
}

// Correspondance route HTTP → fichier handler.
const ROUTES = [
  // Authentification Discord (porte d'entrée)
  ['GET', '/api/auth/discord', '/api/auth/discord.ts'],
  ['GET', '/api/auth/discord-callback', '/api/auth/discord-callback.ts'],
  // Liaison Steam (après Discord)
  ['GET', '/api/auth/steam', '/api/auth/steam.ts'],
  ['GET', '/api/auth/callback', '/api/auth/callback.ts'],
  // Administration
  ['GET', '/api/admin/users', '/api/admin/users.ts'],
  ['POST', '/api/admin/users', '/api/admin/users.ts'],
  ['DELETE', '/api/admin/users', '/api/admin/users.ts'],
  ['GET', '/api/ping', '/api/ping.ts'],
  ['GET', '/api/me', '/api/me.ts'],
  ['POST', '/api/me', '/api/me.ts'],
  ['GET', '/api/group', '/api/group.ts'],
  ['GET', '/api/common', '/api/common.ts'],
  ['POST', '/api/sync', '/api/sync.ts'],
  ['POST', '/api/enrich', '/api/enrich.ts'],
  ['GET', '/api/recommendations', '/api/recommendations.ts'],
  // Événements : handler hors de api/ (limite de fonctions Vercel)
  ['GET', '/api/events', '/lib/handlers/events.ts'],
  ['POST', '/api/events', '/lib/handlers/events.ts'],
  ['POST', '/api/events/create', '/lib/handlers/events-create.ts'],
  ['POST', '/api/events/delete', '/lib/handlers/events-delete.ts'],
  ['GET', '/api/events/channels', '/lib/handlers/events-channels.ts'],
  ['GET', '/api/events/game-search', '/lib/handlers/events-game-search.ts'],
  ['GET', '/api/events/game-info', '/lib/handlers/events-game-info.ts'],
  // Interactions Discord (boutons des annonces d'événements)
  ['POST', '/api/discord/interactions', '/lib/handlers/discord-interactions.ts'],
  // Comptes Steam liés, membres, sorties, Twitch, notifications
  ['GET', '/api/steam-accounts', '/lib/handlers/steam-accounts.ts'],
  ['POST', '/api/steam-accounts', '/lib/handlers/steam-accounts.ts'],
  ['DELETE', '/api/steam-accounts', '/lib/handlers/steam-accounts.ts'],
  ['GET', '/api/members', '/lib/handlers/members.ts'],
  ['POST', '/api/events/interest', '/lib/handlers/events-interest.ts'],
  ['GET', '/api/profile-settings', '/lib/handlers/profile-settings.ts'],
  ['POST', '/api/profile-settings', '/lib/handlers/profile-settings.ts'],
  ['GET', '/api/releases', '/lib/handlers/releases.ts'],
  ['GET', '/api/twitch', '/lib/handlers/twitch.ts'],
  ['POST', '/api/twitch', '/lib/handlers/twitch.ts'],
  ['DELETE', '/api/twitch', '/lib/handlers/twitch.ts'],
  ['GET', '/api/notifications', '/lib/handlers/notifications.ts'],
  ['POST', '/api/notifications', '/lib/handlers/notifications.ts'],
  // Récap' du groupe (image publiée)
  ['GET', '/api/recap', '/lib/handlers/recap.ts'],
  ['GET', '/api/recap/image', '/lib/handlers/recap-image.ts'],
  // Comptes GOG / Epic
  ['GET', '/api/external-accounts', '/lib/handlers/external-accounts.ts'],
  ['POST', '/api/external-accounts', '/lib/handlers/external-accounts.ts'],
  ['DELETE', '/api/external-accounts', '/lib/handlers/external-accounts.ts'],
  // Réglages admin
  ['GET', '/api/admin/settings', '/lib/handlers/admin-settings.ts'],
  ['POST', '/api/admin/settings', '/lib/handlers/admin-settings.ts'],
];

const vite = await createViteServer({
  root,
  server: { middlewareMode: true },
  appType: 'custom',
});

/** Donne au handler l'interface Vercel/Express qu'il attend. */
function makeRes(raw) {
  const res = {
    statusCode: 200,
    _headers: {},
    setHeader(k, v) {
      res._headers[k.toLowerCase()] = v;
      return res;
    },
    getHeader(k) {
      return res._headers[k.toLowerCase()];
    },
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(obj) {
      res.setHeader('content-type', 'application/json; charset=utf-8');
      // On respecte le code posé par res.status(), sinon un 400 devient un 200.
      return res._raw(res.statusCode, JSON.stringify(obj));
    },
    send(body) {
      return res._raw(res.statusCode, String(body ?? ''));
    },
    redirect(code, url) {
      // Certains handlers appellent redirect(url) sans code.
      const [c, u] = typeof code === 'string' ? [302, code] : [code, url];
      res._headers.location = u;
      return res._raw(c, '');
    },
    _raw(status, body) {
      const code = status ?? res.statusCode;
      raw.writeHead(code, res._headers);
      if (body != null && body !== '') raw.end(body);
      else raw.end();
    },
  };
  res._raw = res._raw.bind(res);
  return res;
}

/** Corps de requête : version analysée + version brute (signatures). */
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      if (!data) return resolve({ body: undefined, rawBody: '' });
      try {
        resolve({ body: JSON.parse(data), rawBody: data });
      } catch {
        resolve({ body: data, rawBody: data });
      }
    });
    req.on('error', () => resolve({ body: undefined, rawBody: '' }));
  });
}

async function handleApi(rawReq, rawRes, route, url) {
  const res = makeRes(rawRes);
  try {
    const mod = await vite.ssrLoadModule(route[2]);
    const handler = mod.default;
    if (typeof handler !== 'function') {
      throw new Error(`Le handler ${route[2]} n'exporte pas de fonction.`);
    }

    const { body, rawBody } = await readBody(rawReq);
    const req = {
      method: rawReq.method,
      url: rawReq.url,
      headers: rawReq.headers,
      query: Object.fromEntries(url.searchParams),
      body,
      rawBody,
      cookies: {},
    };
    await handler(req, res);
  } catch (err) {
    console.error(`[api] ${url.pathname}`, err);
    if (!rawRes.headersSent) {
      rawRes.writeHead(500, { 'content-type': 'application/json' });
      rawRes.end(JSON.stringify({ error: err?.message ?? 'Erreur serveur' }));
    }
  }
}

/** Sert index.html passé par Vite (HMR injecté), pour les routes du SPA. */
async function serveIndex(rawReq, rawRes, pathname) {
  try {
    let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    html = await vite.transformIndexHtml(pathname, html);
    rawRes.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    rawRes.end(html);
  } catch (err) {
    console.error('[vite]', err);
    rawRes.writeHead(500, { 'content-type': 'text/plain' });
    rawRes.end('Erreur Vite : ' + err.message);
  }
}

const server = http.createServer((rawReq, rawRes) => {
  const url = new URL(rawReq.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // 1. API
  if (pathname.startsWith('/api/')) {
    const route = ROUTES.find(
      ([m, p]) => p === pathname && m === (rawReq.method || 'GET'),
    );
    if (route) {
      handleApi(rawReq, rawRes, route, url);
      return;
    }
    rawRes.writeHead(404, { 'content-type': 'application/json' });
    rawRes.end(
      JSON.stringify({ error: `Route inconnue : ${rawReq.method} ${pathname}` }),
    );
    return;
  }

  // 2. Vite gère tout le reste (modules, HMR, assets transformés)
  vite.middlewares(rawReq, rawRes, () => {
    // 3. Rien n'a répondu : c'est une route du SPA → index.html
    serveIndex(rawReq, rawRes, pathname);
  });
});

server.listen(PORT, () => {
  console.log(`\n  Steam Match → http://localhost:${PORT}\n`);
});
