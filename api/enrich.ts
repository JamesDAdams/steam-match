import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from '../db/index.ts';
import { gameCache, enrichQueue } from '../db/schema.ts';
import { sql, and, eq, lte, lt } from 'drizzle-orm';
import { getAppDetails, sleep } from '../lib/steam.ts';

/**
 * POST /api/enrich
 * Traite un petit lot de la file d'enrichissement.
 *
 * POURQUOI UN WORKER SÉPARÉ :
 * appdetails est lent (~200 ms) et limité à ~200 requêtes / 5 min.
 * On ne peut donc pas enrichir une ludothèque de 300 jeux dans la requête de
 * sync. On traite par lots de ~15, et on appelle cette route régulièrement
 * (depuis le front après un sync, ou via un cron Vercel).
 * Chaque appid est enrichi UNE fois puis partagé entre tous les utilisateurs.
 *
 * Le lot est petit volontairement pour tenir dans le timeout d'une fonction.
 */
const BATCH = 15;
const DELAY_MS = 250;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const db = getDb();

    // Prend les appids en attente, en excluant ceux déjà enrichis ou en échec
    // temporaire, et les plus prioritaires d'abord.
    const pending = await db
      .select({ appid: enrichQueue.appid })
      .from(enrichQueue)
      .innerJoin(gameCache, eq(enrichQueue.appid, gameCache.appid))
      .where(
        and(
          eq(gameCache.enrichedAt, sql`null` as any),
          lt(gameCache.enrichAttempts, 3),
        ),
      )
      .orderBy(sql`${enrichQueue.priority} DESC`, enrichQueue.createdAt)
      .limit(BATCH);

    const appids = pending.map((p) => p.appid);
    if (appids.length === 0) {
      return res.status(200).json({ ok: true, processed: 0, message: 'Rien à enrichir.' });
    }

    let ok = 0;
    let failed = 0;

    for (const appid of appids) {
      const details = await getAppDetails(appid);

      if (details) {
        await db
          .update(gameCache)
          .set({
            name: details.name,
            headerImage: details.headerImage,
            genres: details.genres,
            tags: details.tags,
            shortDescription: details.shortDescription,
            enrichedAt: new Date(),
            enrichFailed: false,
            updatedAt: new Date(),
          })
          .where(eq(gameCache.appid, appid));
        await db.delete(enrichQueue).where(eq(enrichQueue.appid, appid));
        ok++;
      } else {
        // Échec (souvent 429) : on incrémente et on retentera plus tard.
        await db
          .update(gameCache)
          .set({ enrichAttempts: sql`${gameCache.enrichAttempts} + 1` })
          .where(eq(gameCache.appid, appid));
        failed++;
      }

      await sleep(DELAY_MS);
    }

    const remaining = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(enrichQueue);

    return res.status(200).json({
      ok: true,
      processed: appids.length,
      enriched: ok,
      deferred: failed,
      remaining: remaining[0]?.n ?? 0,
    });
  } catch (err: any) {
    console.error('[enrich]', err);
    return res.status(500).json({ error: err.message });
  }
}
