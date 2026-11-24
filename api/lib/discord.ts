/**
 * Client OAuth2 Discord.
 *
 * Contrairement à Steam (OpenID 2.0), Discord utilise un vrai OAuth2,
 * donc le flux est classique :
 *   1. Redirection vers /oauth2/authorize avec un `state` aléatoire
 *   2. Discord renvoie un `code` sur notre callback
 *   3. On échange le code contre un access_token (côté serveur, avec le secret)
 *   4. On appelle /users/@me pour récupérer l'identité
 *
 * Le `state` protège contre le CSRF : on le stocke dans un cookie httpOnly
 * à courte durée et on vérifie qu'il correspond au retour.
 */

const AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';
const TOKEN_URL = 'https://discord.com/api/oauth2/token';
const API_BASE = 'https://discord.com/api';

export const DISCORD_STATE_COOKIE = 'sm_oauth_state';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `${name} manquant. Crée une application sur https://discord.com/developers/applications puis renseigne .env.local.`,
    );
  }
  return v;
}

export function clientId() {
  return requireEnv('DISCORD_CLIENT_ID');
}

function clientSecret() {
  return requireEnv('DISCORD_CLIENT_SECRET');
}

export function baseUrl() {
  return (process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
}

export function redirectUri() {
  // Doit correspondre EXACTEMENT à ce qui est déclaré dans le portail Discord.
  return process.env.DISCORD_REDIRECT_URI || `${baseUrl()}/api/auth/discord-callback`;
}

/** Un ou plusieurs IDs admin, séparés par des virgules. */
export function adminIds(): string[] {
  return (process.env.DISCORD_ADMIN_ID ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isAdminId(discordId: string): boolean {
  return adminIds().includes(discordId);
}

export function buildAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: clientId(),
    response_type: 'code',
    redirect_uri: redirectUri(),
    scope: 'identify',
    state,
    // Évite une autorisation implicite déjà accordée sans confirmation.
    prompt: 'consent',
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export interface DiscordProfile {
  id: string;
  username: string;
  globalName: string | null;
  avatarUrl: string | null;
}

/**
 * Échange le code d'autorisation contre un token, puis récupère le profil.
 * Le client_secret ne quitte jamais le serveur.
 */
export async function exchangeCode(code: string): Promise<DiscordProfile> {
  const body = new URLSearchParams({
    client_id: clientId(),
    client_secret: clientSecret(),
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(),
  });

  const tokenRes = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!tokenRes.ok) {
    const text = await tokenRes.text().catch(() => '');
    throw new Error(
      `Échange du code Discord refusé (HTTP ${tokenRes.status}). ` +
        `Vérifie DISCORD_CLIENT_ID/SECRET et que l'URI de redirection déclarée ` +
        `correspond exactement à ${redirectUri()}. ${text}`,
    );
  }

  const token = (await tokenRes.json()) as { access_token?: string };
  if (!token.access_token) throw new Error('Discord n’a pas renvoyé de token.');

  const meRes = await fetch(`${API_BASE}/users/@me`, {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  if (!meRes.ok) {
    throw new Error(`Impossible de lire le profil Discord (HTTP ${meRes.status}).`);
  }

  const me = (await meRes.json()) as {
    id: string;
    username: string;
    global_name?: string | null;
    avatar?: string | null;
  };

  const avatarUrl = me.avatar
    ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=128`
    : null;

  return {
    id: me.id,
    username: me.username,
    globalName: me.global_name ?? null,
    avatarUrl,
  };
}
