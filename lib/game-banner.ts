import { getDb } from '../db/index.ts';
import { gameCache } from '../db/schema.ts';
import { eq } from 'drizzle-orm';

/**
 * Construit la bannière d'un événement à partir de la jaquette Steam d'un jeu.
 *
 * POURQUOI CÔTÉ SERVEUR : Discord n'accepte une couverture que sous forme de
 * data URI base64. Le navigateur ne peut pas fabriquer cette data URI depuis
 * une image d'un autre domaine — dessiner la jaquette dans un <canvas> le rend
 * « tainted » et `toDataURL()` lève une exception de sécurité. Le serveur, lui,
 * télécharge les octets et encode, sans contrainte d'origine.
 *
 * Renvoie null si aucune image exploitable : l'événement se crée alors sans
 * bannière, ce qui n'est pas une erreur.
 */

/** Dernière taille acceptée par Discord pour la couverture d'un événement. */
const MAX_BYTES = 8_000_000;

export async function gameBannerDataUri(appid: number): Promise<string | null> {
  if (!Number.isInteger(appid) || appid <= 0) return null;

  const candidates: string[] = [];

  // 1. L'URL exacte stockée lors de l'enrichissement (elle peut pointer vers
  //    un CDN différent de celui qu'on devine).
  try {
    const db = getDb();
    const [row] = await db
      .select({ headerImage: gameCache.headerImage })
      .from(gameCache)
      .where(eq(gameCache.appid, appid))
      .limit(1);
    if (row?.headerImage) candidates.push(row.headerImage);
  } catch {
    /* base indisponible : on tentera l'URL devinée */
  }

  // 2. L'URL canonique des jaquettes Steam (460×215, JPEG).
  candidates.push(
    `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`,
  );

  for (const url of candidates) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(8_000),
        headers: { accept: 'image/*' },
      });
      if (!res.ok) continue;

      const type = (res.headers.get('content-type') ?? '').split(';')[0].trim();
      if (!type.startsWith('image/')) continue;

      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length === 0 || buffer.length > MAX_BYTES) continue;

      return `data:${type};base64,${buffer.toString('base64')}`;
    } catch {
      /* URL suivante */
    }
  }

  return null;
}
