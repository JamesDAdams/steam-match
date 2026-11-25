import { getDb } from '../db/index';
import { sessions } from '../db/schema';
import { eq } from 'drizzle-orm';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';

const COOKIE_NAME = 'sm_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 jours

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) {
    throw new Error(
      'SESSION_SECRET manquant ou trop court (32+ caractères). ' +
        'Génère-le avec : openssl rand -hex 32',
    );
  }
  return s;
}

function newToken() {
  return randomBytes(32).toString('hex');
}

/**
 * Le token est stocké tel quel en DB et signé dans le cookie.
 * La signature permet de rejeter un token forgé sans interroger la base.
 */
function sign(token: string) {
  return createHmac('sha256', secret()).update(token).digest('hex');
}

/* ─────────────────────────── Session ─────────────────────────── */

export async function createSession(discordId: string) {
  const db = getDb();
  const token = newToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await db.insert(sessions).values({ token, discordId, expiresAt });

  return { token, cookie: buildCookie(token, expiresAt) };
}

export async function readSession(rawCookieValue: string | undefined | null) {
  if (!rawCookieValue) return null;

  const sep = rawCookieValue.lastIndexOf('.');
  if (sep <= 0) return null;

  const token = rawCookieValue.slice(0, sep);
  const sig = rawCookieValue.slice(sep + 1);
  if (!safeEqual(sig, sign(token))) return null;

  const db = getDb();
  const [row] = await db.select().from(sessions).where(eq(sessions.token, token)).limit(1);

  if (!row) return null;
  if (row.expiresAt.getTime() <= Date.now()) return null;

  return row;
}

export async function destroySession(token: string) {
  const db = getDb();
  await db.delete(sessions).where(eq(sessions.token, token));
}

/* ─────────────────── Cookie state OAuth Discord ─────────────────── */

/** Cookie court pour le `state` anti-CSRF de l'OAuth Discord. */
export function buildStateCookie(state: string) {
  const secure = (process.env.BASE_URL ?? '').startsWith('https://');
  return [
    `sm_oauth_state=${state}`,
    'Path=/api/auth',
    'HttpOnly',
    'SameSite=Lax',
    secure ? 'Secure' : '',
    'Max-Age=600', // 10 minutes
  ]
    .filter(Boolean)
    .join('; ');
}

export function clearStateCookie() {
  return 'sm_oauth_state=; Path=/api/auth; HttpOnly; SameSite=Lax; Max-Age=0';
}

/* ─────────────────────────── Utilitaires ─────────────────────────── */

function safeEqual(a: string, b: string) {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function buildCookie(token: string, expiresAt: Date) {
  const value = `${token}.${sign(token)}`;
  const secure = (process.env.BASE_URL ?? '').startsWith('https://');
  return [
    `${COOKIE_NAME}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    secure ? 'Secure' : '',
    `Expires=${expiresAt.toUTCString()}`,
    'Max-Age=' + Math.floor(SESSION_TTL_MS / 1000),
  ]
    .filter(Boolean)
    .join('; ');
}

export function parseCookies(header: string | undefined | null) {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

export function clearCookie() {
  const secure = (process.env.BASE_URL ?? '').startsWith('https://');
  return [
    `${COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    secure ? 'Secure' : '',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'Max-Age=0',
  ]
    .filter(Boolean)
    .join('; ');
}

export { COOKIE_NAME };
