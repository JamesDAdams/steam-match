/**
 * Vérifie la construction des requêtes envoyées à l'API Discord.
 *
 * POURQUOI CE TEST : un champ mal nommé (`entity_type` au lieu de
 * `entityType`, `privacy_level` oublié, date non ISO) ne casse rien au
 * build — Discord répond juste 400, en anglais, au moment où l'admin clique
 * sur « Créer ». On intercepte donc `fetch` et on inspecte le corps envoyé.
 *
 * Le test ne contacte AUCUN serveur : tout est simulé.
 *
 * Usage : node scripts/test-discord-bot.mjs
 */
import { createServer } from 'vite';

// Le module lit ces variables au moment de l'appel.
process.env.DISCORD_BOT_TOKEN = 'jeton-de-test';
process.env.DISCORD_GUILD_ID = '111111111111111111';

const GUILD = '111111111111111111';
// Identifiant FICTIF du bot : ce test ne parle à aucun serveur. Ne jamais y
// mettre le vrai identifiant d'application, Netlify bloque le build quand la
// valeur d'une variable d'environnement apparaît dans le dépôt.
const BOT_ID = '123456789012345678';

const MANAGE_EVENTS = 1n << 33n;
const CREATE_EVENTS = 1n << 44n;

/** Requêtes interceptées : { method, path, body }. */
const calls = [];

let failChannels = false;
/** true = le POST de création renvoie 403 (permission retirée). */
let denyCreate = false;
/** true = le DELETE de suppression renvoie 403. */
let denyDelete = false;
/** Rôles du bot renvoyés par /members/@me. */
let botRoles = ['role-create'];

globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  const path = u.pathname.replace('/api/v10', '');
  const method = (init.method || 'GET').toUpperCase();

  calls.push({
    method,
    path,
    body: init.body ? JSON.parse(String(init.body)) : null,
  });

  const json = (status, data) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  // Identité du bot (servie en cache par le module).
  if (method === 'GET' && path === '/users/@me') {
    return json(200, { id: BOT_ID, username: 'steam-match' });
  }

  // Le serveur, avec ses rôles (nécessaire au calcul des permissions).
  if (method === 'GET' && path === `/guilds/${GUILD}`) {
    return json(200, {
      id: GUILD,
      name: 'Serveur de test',
      roles: [
        // CONNECT (1<<20) et VIEW_CHANNEL (1<<10) accordés au niveau serveur :
        // c'est une surcharge de salon qui les retire, comme sur un vrai serveur.
        { id: GUILD, permissions: String(MANAGE_EVENTS | (1n << 20n) | (1n << 10n)) },
        { id: 'role-create', permissions: String(CREATE_EVENTS) },
        { id: 'role-sans-droit', permissions: '0' },
      ],
    });
  }

  if (method === 'GET' && path.startsWith(`/guilds/${GUILD}/members/`)) {
    const id = path.split('/').pop();
    if (id === BOT_ID) return json(200, { user: { id }, roles: botRoles });
    // 404 = pas membre (le bot, lui, voit bien le serveur).
    if (id === '222222222222222222') return json(200, { user: { id }, roles: [] });
    return json(404, { code: 10007, message: 'Unknown Member' });
  }

  if (method === 'GET' && path === `/guilds/${GUILD}/channels`) {
    if (failChannels) return json(403, { message: 'Missing Access', code: 50001 });
    return json(200, [
      { id: '3', name: 'Salon texte', type: 0, position: 0 },
      // Aucune surcharge : le bot hérite de CONNECT du serveur.
      { id: '2', name: 'Vocal B', type: 2, position: 2 },
      // @everyone autorise Voir (1024) mais refuse Se connecter (1048576).
      {
        id: '1',
        name: 'Vocal A',
        type: 2,
        position: 1,
        permission_overwrites: [
          { id: GUILD, type: 0, allow: '1024', deny: '1048576' },
        ],
      },
      { id: '4', name: 'Scène', type: 13, position: 3 },
    ]);
  }

  if (method === 'DELETE' && path.startsWith(`/guilds/${GUILD}/scheduled-events/`)) {
    if (denyDelete) {
      return json(403, { message: 'Missing Permissions', code: 50013 });
    }
    // 404 = événement déjà supprimé côté Discord.
    if (path.endsWith('999999999999999999')) {
      return new Response(null, { status: 404 });
    }
    return new Response(null, { status: 204 });
  }

  if (method === 'POST' && path === `/guilds/${GUILD}/scheduled-events`) {
    if (denyCreate) {
      return json(403, { message: 'Missing Permissions', code: 50013 });
    }
    const body = JSON.parse(String(init.body));
    return json(201, {
      id: '999',
      guild_id: GUILD,
      name: body.name,
      description: body.description ?? null,
      scheduled_start_time: body.scheduled_start_time,
      scheduled_end_time: body.scheduled_end_time ?? null,
      status: 1,
      entity_type: body.entity_type,
      entity_metadata: body.entity_metadata ?? null,
      image: body.image ?? null,
    });
  }

  return json(500, { message: `Route simulée inconnue : ${method} ${path}` });
};

const vite = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
});

/** Instance de module neuve : les caches (identité, permissions) sont isolés. */
let instances = 0;
async function freshModule() {
  instances++;
  return vite.ssrLoadModule(`/lib/discord-bot.ts?i=${instances}`);
}

const mod = await freshModule();

let failures = 0;

function check(label, ok, detail = '') {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : ` → ${detail}`}`);
}

// ── 1. Appartenance au serveur ────────────────────────────────────────
console.log('  — Appartenance au serveur —');
const member = await mod.getGuildMember('222222222222222222');
check('membre reconnu', member?.user?.id === '222222222222222222');

const absent = await mod.getGuildMember('333333333333333333');
check('non-membre → null (404)', absent === null);

// La sonde du serveur a bien été faite une fois, pas à chaque appel.
const probes = calls.filter((c) => c.path === `/guilds/${GUILD}`).length;
check('sonde du serveur mise en cache (1 appel)', probes === 1, `${probes} appels`);

// ── 2. Salons ─────────────────────────────────────────────────────────
console.log('  — Salons —');
const channels = await mod.listEventChannels();
check(
  'seuls les vocaux et scènes sont gardés',
  channels.length === 3 && channels.every((c) => c.type === 2 || c.type === 13),
  JSON.stringify(channels.map((c) => c.name)),
);
check(
  'tri par position',
  channels.map((c) => c.name).join(',') === 'Vocal A,Vocal B,Scène',
  channels.map((c) => c.name).join(','),
);

failChannels = true;
let channelError = null;
try {
  await mod.listEventChannels();
} catch (e) {
  channelError = e.message;
}
check('erreur 403 des salons remontée', Boolean(channelError), String(channelError));
failChannels = false;

// ── 3. Permissions effectives ─────────────────────────────────────────
console.log('  — Permissions du bot —');
const perms = await mod.getBotPermissions({ force: true });
check('Créer des événements détecté', perms.createEvents === true);
check('Gérer les événements détecté', perms.manageEvents === true);
check('administrateur non accordé', perms.administrator === false);

// Un bot sans le rôle adéquat : la permission doit être vue comme absente.
const modSansDroit = await freshModule();
botRoles = ['role-sans-droit'];
const perms2 = await modSansDroit.getBotPermissions({ force: true });
check('permission absente détectée', perms2.createEvents === false && perms2.manageEvents === true);
botRoles = ['role-create'];

// ── 3 bis. Accès par salon ────────────────────────────────────────────
// Un événement vocal exige « Voir » ET « Se connecter » sur le salon, même
// quand le rôle du bot a « Créer des événements » au niveau du serveur.
console.log('  — Accès aux salons —');
const access = await mod.getBotChannelAccess({ force: true });

check(
  'salon sans surcharge : voir + se connecter',
  access['2']?.canView === true && access['2']?.canConnect === true,
  JSON.stringify(access['2']),
);
check(
  '« Se connecter » refusé par une surcharge détecté',
  access['1']?.canView === true && access['1']?.canConnect === false,
  JSON.stringify(access['1']),
);
check('salon texte ignoré', access['3'] === undefined);

// ── 4. Création d'un événement vocal ──────────────────────────────────
console.log('  — Création (vocal) —');
calls.length = 0;

const start = new Date('2026-03-14T20:30:00.000Z');
const end = new Date('2026-03-14T22:30:00.000Z');
const cover = 'data:image/jpeg;base64,/9j/AAAA';

const created = await mod.createScheduledEvent({
  name: 'Soirée survie',
  description: 'On joue à Valheim',
  startAt: start,
  endAt: end,
  entityType: 2,
  channelId: '1',
  image: cover,
});

const vocal = calls.find((c) => c.method === 'POST')?.body;

check('événement renvoyé par Discord', created?.id === '999');
check('privacy_level = 2 (visible par le serveur)', vocal?.privacy_level === 2);
check('entity_type = 2 (vocal)', vocal?.entity_type === 2);
check('channel_id transmis', vocal?.channel_id === '1');
check('aucun entity_metadata en vocal', vocal?.entity_metadata === undefined);
check('début en ISO UTC', vocal?.scheduled_start_time === start.toISOString());
check('fin en ISO UTC', vocal?.scheduled_end_time === end.toISOString());
check('nom et description transmis', vocal?.name === 'Soirée survie' && vocal?.description === 'On joue à Valheim');
check('bannière transmise en data URI', vocal?.image === cover);

// ── 5. Création d'un événement externe ────────────────────────────────
console.log('  — Création (lieu externe) —');
calls.length = 0;

await mod.createScheduledEvent({
  name: 'Tournoi en salle',
  startAt: start,
  entityType: 3,
  location: 'Bar Le D20, Lyon',
});

const externe = calls.find((c) => c.method === 'POST')?.body;

check('entity_type = 3 (externe)', externe?.entity_type === 3);
check(
  'lieu dans entity_metadata',
  externe?.entity_metadata?.location === 'Bar Le D20, Lyon',
);
check('aucun channel_id en externe', externe?.channel_id === undefined);
check('fin omise quand absente', externe?.scheduled_end_time === undefined);
check('description omise quand vide', externe?.description === undefined);
check('bannière omise quand absente', externe?.image === undefined);

// ── 6. Refus 403 : le message doit nommer le bot et la permission ─────
console.log('  — Refus 403 (permission retirée) —');
denyCreate = true;
botRoles = ['role-sans-droit'];

const modDenied = await freshModule();
let refusal = null;
try {
  await modDenied.createScheduledEvent({
    name: 'Test refus',
    startAt: start,
    entityType: 3,
    location: 'Test',
  });
} catch (e) {
  refusal = e.message;
}

check('refus explicite', Boolean(refusal), String(refusal));
check('nomme le bot réellement utilisé', /steam-match/.test(refusal ?? ''), String(refusal));
check(
  'identifie la permission manquante',
  /Créer des événements/.test(refusal ?? ''),
  String(refusal),
);

// Cas où les permissions sont bonnes mais Discord refuse quand même :
// le message doit alors orienter vers DISCORD_GUILD_ID / le jeton.
botRoles = ['role-create'];
const modRefusMystere = await freshModule();
let refusal2 = null;
try {
  await modRefusMystere.createScheduledEvent({
    name: 'Test refus 2',
    startAt: start,
    entityType: 3,
    location: 'Test',
  });
} catch (e) {
  refusal2 = e.message;
}
check(
  'oriente vers DISCORD_GUILD_ID / le jeton',
  /DISCORD_GUILD_ID/.test(refusal2 ?? ''),
  String(refusal2),
);
denyCreate = false;

// ── 6 bis. Refus 403 sur salon vocal : CONNECT manquant ───────────────
console.log('  — Refus sur salon vocal (surcharge du salon) —');
denyCreate = true;

const modVoice = await freshModule();
let voiceRefusal = null;
try {
  await modVoice.createScheduledEvent({
    name: 'Test vocal',
    startAt: start,
    entityType: 2,
    channelId: '1',
  });
} catch (e) {
  voiceRefusal = e.message;
}

check(
  'message nomme « Se connecter »',
  /Se connecter/.test(voiceRefusal ?? ''),
  String(voiceRefusal),
);
check(
  'message ne dit pas « Créer des événements » manquant',
  !/Créer des événements/.test(voiceRefusal ?? ''),
  String(voiceRefusal),
);
denyCreate = false;

// ── 7. Suppression ────────────────────────────────────────────────────
console.log('  — Suppression —');
calls.length = 0;
denyDelete = false;

await mod.deleteScheduledEvent('123456789012345678');
const del = calls.find((c) => c.method === 'DELETE');
check('requête DELETE envoyée', Boolean(del), JSON.stringify(calls.map((c) => c.method)));
check(
  'chemin de l’événement correct',
  del?.path === `/guilds/${GUILD}/scheduled-events/123456789012345678`,
  String(del?.path),
);

// Un 404 signifie « déjà supprimé » : ce n'est pas une erreur pour l'appelant.
const modMissing = await freshModule();
let missingError = null;
try {
  await modMissing.deleteScheduledEvent('999999999999999999');
} catch (e) {
  missingError = e.message;
}
check('404 toléré (déjà supprimé)', missingError === null, String(missingError));

// Un 403 doit être explicite et nommer la permission manquante.
denyDelete = true;
const modForbidden = await freshModule();
let forbidden = null;
try {
  await modForbidden.deleteScheduledEvent('123456789012345678');
} catch (e) {
  forbidden = e.message;
}
check('403 explicite', Boolean(forbidden), String(forbidden));
check(
  '403 nomme « Gérer les événements »',
  /Gérer les événements/.test(forbidden ?? ''),
  String(forbidden),
);
denyDelete = false;

// ── 8. Bot hors du serveur : erreur explicite, pas « pas membre » ─────
console.log('  — Bot absent du serveur —');
const savedFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.pathname.endsWith(`/guilds/${GUILD}`)) {
    return new Response(JSON.stringify({ message: 'Unknown Guild' }), { status: 404 });
  }
  return savedFetch(url, init);
};

const mod2 = await freshModule();
let guildError = null;
try {
  await mod2.getGuildMember('222222222222222222');
} catch (e) {
  guildError = e.message;
}
check(
  '404 sur le serveur → exception (et non « pas membre »)',
  Boolean(guildError) && /bot n’est pas membre/.test(guildError),
  String(guildError),
);

globalThis.fetch = savedFetch;

await vite.close();
console.log(failures === 0 ? '\nAPI Discord : OK' : `\n${failures} échec(s)`);
process.exit(failures === 0 ? 0 : 1);
