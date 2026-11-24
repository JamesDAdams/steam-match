import type { VercelRequest, VercelResponse } from '@vercel/node';
import { COOKIE_NAME, parseCookies, destroySession, clearCookie } from '../lib/session.ts';

/**
 * POST /api/auth/logout
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const cookies = parseCookies(req.headers.cookie);
  const raw = cookies[COOKIE_NAME];

  if (raw) {
    const token = raw.slice(0, raw.lastIndexOf('.'));
    await destroySession(token).catch(() => {});
  }

  res.setHeader('Set-Cookie', clearCookie());
  return res.status(200).json({ ok: true });
}
