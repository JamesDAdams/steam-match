/**
 * Fonction catch-all Netlify.
 *
 * POURQUOI UNE SEULE FONCTION :
 * nos handlers sont écrits pour l'interface Vercel (req, res). Plutôt que de
 * réécrire 11 fichiers, on branche ici un adaptateur qui traduit l'événement
 * Netlify en (req, res) et la réponse en { statusCode, headers, body }.
 *
 * AVANTAGE PAR RAPPORT À VERCEL :
 * le bundler Netlify (esbuild) empaquette tout le projet en une fois. Plus
 * besoin de includeFiles pour embarquer db/ et lib/, plus de limite de
 * 12 fonctions, plus de problème de résolution ESM.
 */
import type { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';

// Handlers de l'application (mêmes fichiers que sur Vercel).
import pingHandler from '../../api/ping.ts';
import meHandler from '../../api/me.ts';
import groupHandler from '../../api/group.ts';
import commonHandler from '../../api/common.ts';
import syncHandler from '../../api/sync.ts';
import enrichHandler from '../../api/enrich.ts';
import recommendationsHandler from '../../api/recommendations.ts';
import authSteamHandler from '../../api/auth/steam.ts';
import authCallbackHandler from '../../api/auth/callback.ts';
import authDiscordHandler from '../../api/auth/discord.ts';
import authDiscordCallbackHandler from '../../api/auth/discord-callback.ts';
import adminUsersHandler from '../../api/admin/users.ts';
import eventsHandler from '../../lib/handlers/events.ts';

interface Route {
  /** Méthodes acceptées. Vide = toutes. */
  methods: string[];
  module: any;
}

/**
 * Table de routage. Le chemin est comparé sans le préfixe /api.
 * L'ordre n'importe pas : les chemins sont distincts.
 */
const ROUTES: Record<string, Route> = {
  '/ping': { methods: ['GET'], module: pingHandler },
  '/me': { methods: ['GET', 'POST'], module: meHandler },
  '/group': { methods: ['GET'], module: groupHandler },
  '/common': { methods: ['GET'], module: commonHandler },
  '/sync': { methods: ['POST'], module: syncHandler },
  '/enrich': { methods: ['POST'], module: enrichHandler },
  '/recommendations': { methods: ['GET'], module: recommendationsHandler },
  '/auth/steam': { methods: ['GET'], module: authSteamHandler },
  '/auth/callback': { methods: ['GET'], module: authCallbackHandler },
  '/auth/discord': { methods: ['GET'], module: authDiscordHandler },
  '/auth/discord-callback': { methods: ['GET'], module: authDiscordCallbackHandler },
  '/admin/users': { methods: ['GET', 'POST', 'DELETE'], module: adminUsersHandler },
  '/events': { methods: ['GET', 'POST'], module: eventsHandler },
};

/**
 * Reconstitue le chemin d'origine.
 *
 * Le redirect Netlify a réécrit l'URL vers /.netlify/functions/api ; `rawUrl`
 * conserve l'adresse demandée par le navigateur, c'est donc la source fiable.
 */
function originalPath(event: HandlerEvent): string {
  try {
    const url = new URL(event.rawUrl);
    return url.pathname;
  } catch {
    return event.path;
  }
}

/** Traduit un HandlerEvent en `req` façon Vercel/Express. */
function toRequest(event: HandlerEvent, pathname: string): any {
  const url = new URL(event.rawUrl ?? `http://localhost${event.path}`);

  let body: any = event.body;
  if (body && event.isBase64Encoded) {
    body = Buffer.from(body, 'base64').toString('utf8');
  }
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      /* corps non JSON : on garde la chaîne brute */
    }
  }

  return {
    method: (event.httpMethod || 'GET').toUpperCase(),
    url: event.rawUrl ?? event.path,
    path: pathname,
    headers: event.headers ?? {},
    query: event.queryStringParameters ?? {},
    body,
    cookies: {},
  };
}

/** Accumule une réponse façon Express et la restitue au format Netlify. */
function createResponse() {
  const headers: Record<string, string | string[]> = {};
  let statusCode = 200;
  let finalResult: { statusCode: number; headers: any; body: string } | null = null;

  const finish = (body: string) => {
    finalResult = { statusCode, headers, body };
    return finalResult;
  };

  const res: any = {
    setHeader(key: string, value: string | string[]) {
      // Netlify gère nativement un tableau pour Set-Cookie (plusieurs cookies).
      headers[key.toLowerCase()] = value;
      return res;
    },
    getHeader(key: string) {
      return headers[key.toLowerCase()];
    },
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(obj: unknown) {
      headers['content-type'] = 'application/json; charset=utf-8';
      return finish(JSON.stringify(obj));
    },
    send(payload: unknown) {
      return finish(String(payload ?? ''));
    },
    redirect(codeOrUrl: number | string, maybeUrl?: string) {
      const [code, url] =
        typeof codeOrUrl === 'string' ? [302, codeOrUrl] : [codeOrUrl, maybeUrl];
      statusCode = code;
      headers.location = url as string;
      return finish('');
    },
    end(payload?: unknown) {
      return finish(payload == null ? '' : String(payload));
    },
  };

  // Permet de récupérer la réponse même si le handler n'a pas fait `return`.
  Object.defineProperty(res, '__result', {
    get: () => finalResult,
  });

  return res;
}

export const handler: Handler = async (
  event: HandlerEvent,
  context: HandlerContext,
) => {
  const pathname = originalPath(event);

  // Le redirect peut aussi arriver sous la forme /.netlify/functions/api/...
  const routePath = pathname
    .replace(/^\/\.netlify\/functions\/api/, '')
    .replace(/^\/api/, '')
    .replace(/\/+$/, '') || '/';

  const route = ROUTES[routePath];

  if (!route) {
    return {
      statusCode: 404,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        error: `Route inconnue : ${event.httpMethod} /api${routePath}`,
      }),
    };
  }

  const method = (event.httpMethod || 'GET').toUpperCase();
  if (!route.methods.includes(method)) {
    return {
      statusCode: 405,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        error: `Méthode ${method} non supportée sur /api${routePath}`,
      }),
    };
  }

  const req = toRequest(event, pathname);
  const res = createResponse();

  try {
    const handlerFn = route.module?.default ?? route.module;
    if (typeof handlerFn !== 'function') {
      throw new Error(`Le module de /api${routePath} n'exporte pas de handler.`);
    }

    const result = await handlerFn(req, res);

    // Nos handlers font `return res.json(...)` : la valeur de retour EST déjà
    // la réponse au format Netlify.
    if (result && typeof result === 'object' && 'statusCode' in result) {
      return result;
    }

    // Sinon ils ont appelé res.json(...) sans retour : on relit la réponse.
    if (res.__result) return res.__result;

    return { statusCode: 200, headers: {}, body: '' };
  } catch (err: any) {
    console.error('[netlify api]', routePath, err);
    return {
      statusCode: 500,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        error: err?.message ?? 'Erreur serveur',
        route: routePath,
      }),
    };
  }
};
