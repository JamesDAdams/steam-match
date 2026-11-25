import { getDb } from '../db/index.ts';
import { gameCache, enrichQueue } from '../db/schema.ts';
import { and, eq, lt, sql } from 'drizzle-orm';
import { fetchMetadata } from './metadata.ts';
import { fetchCheapestPrice, fetchSteamPrice } from './prices.ts';

/**
 * Worker d'enrichissement.
 *
 * POURQUOI UN WORKER SÉPARÉ :
 * il est appelé par deux chemins — la fonction planifiée Netlify (toutes les
 * 10 minutes, sans intervention) et, en cas de besoin, une route HTTP manuelle.
 * La logique est donc ici, pas dans un handler.
 *
 * Chaque appid est enrichi UNE SEULE FOIS, puis partagé entre tous les
 * membres : son nom, ses genres et son prix servent à tout le monde.
 */

export interface EnrichBatchResult {
  processed: number;
  enriched: number;
  deferred: number;
  remaining: number;
}

const MAX_ATTEMPTS = 3;

/**
 * Traite un lot de jeux en attente.
 *
 * @param batchSize nombre de jeux traités dans cet appel
 * @param withPrices récupérer aussi le prix de la clé (plus lent)
 */
export async function runEnrichBatch(
  batchSize = 10,
  withPrices = true,
): Promise<EnrichBatchResult> {
  const db = getDb();

  // File d'attente : uniquement les jeux pas encore enrichis et pas en échec
  // définitif. Les priorités les plus hautes passent d'abord.
  const pending = await db
    .select({ appid: enrichQueue.appid })
    .from(enrichQueue)
    .innerJoin(gameCache, eq(enrichQueue.appid, gameCache.appid))
    .where(
      and(
        sql`${gameCache.enrichedAt} is null`,
        lt(gameCache.enrichAttempts, MAX_ATTEMPTS),
      ),
    )
    .orderBy(sql`${enrichQueue.priority} DESC`, enrichQueue.createdAt)
    .limit(batchSize);

  const appids = pending.map((p) => p.appid);

  if (appids.length === 0) {
    return { processed: 0, enriched: 0, deferred: 0, remaining: 0 };
  }

  let enriched = 0;
  let deferred = 0;

  for (const appid of appids) {
    const meta = await fetchMetadata(appid);

    if (!meta) {
      // Échec temporaire (quota, réseau) : on réessaiera plus tard.
      await db
        .update(gameCache)
        .set({ enrichAttempts: sql`${gameCache.enrichAttempts} + 1` })
        .where(eq(gameCache.appid, appid));
      deferred++;
      continue;
    }

    // Deux prix distincts : la boutique officielle et le meilleur revendeur.
    const steamPrice = withPrices ? await fetchSteamPrice(appid) : null;
    const price = withPrices ? await fetchCheapestPrice(appid) : null;

    await db
      .update(gameCache)
      .set({
        name: meta.name,
        genres: meta.genres,
        tags: meta.tags,
        shortDescription: meta.shortDescription,
        enrichedAt: new Date(),
        enrichFailed: false,
        updatedAt: new Date(),
        ...(price
          ? {
              cheapestPrice: price.priceCents,
              cheapestStore: price.store,
              cheapestCurrency: price.currency,
            }
          : {}),
        ...(steamPrice
          ? {
              steamPrice: steamPrice.priceCents,
              steamInitialPrice: steamPrice.initialCents,
              steamDiscount: steamPrice.discountPercent,
              steamCurrency: steamPrice.currency,
            }
          : {}),
        ...(price || steamPrice ? { priceUpdatedAt: new Date() } : {}),
      })
      .where(eq(gameCache.appid, appid));

    await db.delete(enrichQueue).where(eq(enrichQueue.appid, appid));
    enriched++;
  }

  const [remainingRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(enrichQueue);

  return {
    processed: appids.length,
    enriched,
    deferred,
    remaining: remainingRow?.n ?? 0,
  };
}

/**
 * Traite plusieurs lots d'affilée, dans la limite d'un budget de temps.
 *
 * Utilisé par la tâche planifiée : elle ne doit pas dépasser le temps
 * d'exécution autorisé, donc on s'arrête dès que le budget est consommé.
 */
export async function runEnrichUntilBudget(
  maxBatches = 5,
  batchSize = 10,
  budgetMs = 20_000,
): Promise<EnrichBatchResult> {
  const started = Date.now();
  let processed = 0;
  let enriched = 0;
  let deferred = 0;
  let remaining = 0;

  for (let i = 0; i < maxBatches; i++) {
    if (Date.now() - started > budgetMs) break;

    const r = await runEnrichBatch(batchSize);
    processed += r.processed;
    enriched += r.enriched;
    deferred += r.deferred;
    remaining = r.remaining;

    if (r.processed === 0) break; // file vide
    if (r.enriched === 0) break; // quota atteint : inutile d'insister
  }

  return { processed, enriched, deferred, remaining };
}
