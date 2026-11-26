import { getDb } from '../db/index.ts';
import { isSoftwareApp } from './software.ts';
import { gameCache, enrichQueue } from '../db/schema.ts';
import { eq, sql } from 'drizzle-orm';
import { fetchMetadata } from './metadata.ts';
import { fetchCheapestPrice, fetchSteamPrice } from './prices.ts';

/**
 * Worker d'enrichissement.
 *
 * POURQUOI DEUX PHASES
 * --------------------
 * Un jeu a besoin de données de coûts très différents :
 *   - métadonnées (nom, genres, tags, avis) : SteamSpy, rapide, ~150 ms ;
 *   - prix et date (Steam) + prix des clés (CheapShark) : lents et limités.
 *
 * Les enchaîner par jeu, comme avant, imposait d'attendre le prix d'un jeu
 * avant d'identifier le suivant : ~1 s par jeu, soit des heures pour quelques
 * centaines de titres. On sépare donc les deux :
 *
 *   Phase 1 — métadonnées : tous les jeux sont nommés très vite.
 *   Phase 2 — prix : Steam et CheapShark, à leur rythme, en arrière-plan.
 *
 * L'utilisateur voit donc sa ludothèque se remplir en quelques dizaines de
 * secondes, et les prix arrivent ensuite.
 *
 * CONCURRENCE ET LIMITES
 * ----------------------
 * Chaque hôte a son propre espacement minimal (lib/rate-limit.ts). Les jeux
 * sont traités en parallèle, mais les appels à un même hôte restent espacés :
 * la concurrence masque la latence, pas la limite de débit.
 *
 * RÉCLAMATION
 * -----------
 * Le cron et un appel manuel peuvent tourner simultanément. On réserve donc
 * les lignes traitées (`enrich_claimed_at`) : la marque expire au bout de
 * 3 minutes si le processus meurt en route.
 */

export interface EnrichResult {
  /** Jeux identifiés (métadonnées) pendant cet appel. */
  metaDone: number;
  /** Jeux dont les prix ont été récupérés pendant cet appel. */
  priceDone: number;
  /** Jeux encore sans nom. */
  metaPending: number;
  /** Jeux identifiés mais sans prix. */
  pricePending: number;
  durationMs: number;
}

export interface EnrichOptions {
  /** Budget de temps total de l'appel (ms). */
  budgetMs?: number;
  /** Récupérer aussi les prix (sinon métadonnées seules). */
  withPrices?: boolean;
}

const MAX_ATTEMPTS = 3;
/**
 * Un jeu peut échouer définitivement sur les genres/prix (délisté, région…),
 * mais on ne veut PAS abandonner son NOM : un « App 12345 » qui ne progresse
 * plus restait affiché indéfiniment comme « en cours d'identification ».
 * Ces lignes gardent donc une marge de tentatives plus large.
 */
const MAX_ATTEMPTS_UNNAMED = 10;

/**
 * Version courante du schéma d'enrichissement.
 * 1 : nom + genres + tags
 * 2 : + date de sortie, modes de jeu, avis Steam, prix
 * Incrémenter force la reprise des jeux déjà enrichis.
 */
const ENRICH_VERSION = 2;

/** Parallélisme : les limiteurs de débit restent le vrai plafond. */
const META_CONCURRENCY = 6;
const PRICE_CONCURRENCY = 4;

/**
 * Durée estimée d'un jeu, utilisée pour ne pas démarrer un traitement qui
 * dépasserait le budget. Volontairement pessimiste : mieux vaut un appel un
 * peu plus court qu'une fonction tuée par Netlify.
 */
const META_ESTIMATE_MS = 600;
const PRICE_ESTIMATE_MS = 1500;

/**
 * Durée de validité d'une réclamation, si un worker meurt en route.
 *
 * Courte volontairement : un passage dure moins de 10 s. Si la fonction est
 * tuée avant de libérer ses réservations, elles doivent redevenir disponibles
 * au passage suivant (une minute plus tard), pas trois.
 */
const CLAIM_TTL_MINUTES = 1;

/**
 * Nombre de jeux réservés par phase.
 *
 * Il doit rester proche de ce qu'un passage peut réellement traiter : réserver
 * 400 lignes pour n'en traiter que 10 bloquait tout le reste jusqu'à
 * l'expiration de la réservation.
 */
const META_CLAIM = 80;
const PRICE_CLAIM = 24;

/**
 * Réserve des appids à traiter, atomiquement.
 *
 * L'UPDATE est la clé : contrairement à un simple SELECT, il pose un verrou
 * sur chaque ligne et réévalue la condition `enrich_claimed_at`, donc deux
 * workers simultanés ne peuvent pas réserver le même jeu.
 */
async function claimPending(
  kind: 'meta' | 'price',
  limit: number,
): Promise<number[]> {
  const db = getDb();

  const pending =
    kind === 'meta'
      ? sql.raw('gc2.enriched_at IS NULL')
      : sql.raw(
          `gc2.enriched_at IS NOT NULL AND gc2.enrich_version < ${ENRICH_VERSION}`,
        );

  // Les lignes encore sans nom gardent une marge de tentatives plus large.
  const attemptsOk =
    kind === 'meta'
      ? sql.raw(
          `(gc2.enrich_attempts < ${MAX_ATTEMPTS} OR (gc2.name ~ '^App [0-9]+$' AND gc2.enrich_attempts < ${MAX_ATTEMPTS_UNNAMED}))`,
        )
      : sql.raw(`gc2.enrich_attempts < ${MAX_ATTEMPTS}`);

  const result = await db.execute(sql`
    UPDATE game_cache AS gc
    SET enrich_claimed_at = now()
    WHERE gc.appid IN (
      SELECT gc2.appid
      FROM game_cache AS gc2
      LEFT JOIN enrich_queue AS eq ON eq.appid = gc2.appid
      WHERE ${pending}
        AND ${attemptsOk}
        AND (
          gc2.enrich_claimed_at IS NULL
          OR gc2.enrich_claimed_at < now() - interval '${sql.raw(String(CLAIM_TTL_MINUTES))} minutes'
        )
      ORDER BY COALESCE(eq.priority, 0) DESC, gc2.updated_at ASC
      LIMIT ${limit}
    )
    AND (
      gc.enrich_claimed_at IS NULL
      OR gc.enrich_claimed_at < now() - interval '${sql.raw(String(CLAIM_TTL_MINUTES))} minutes'
    )
    RETURNING gc.appid
  `);

  return (result.rows as { appid: number }[]).map((r) => Number(r.appid));
}

/** Exécute `worker` sur `items` avec un parallélisme borné et une échéance. */
async function runPool<T>(
  items: T[],
  deadline: number,
  concurrency: number,
  estimateMs: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;

  // On ne démarre un jeu que s'il reste de quoi le terminer. Sans cette marge,
  // un dernier appel commencé à l'échéance dépassait le budget de plusieurs
  // secondes — assez pour faire expirer la fonction Netlify.
  const canStart = () => Date.now() + estimateMs < deadline;

  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (canStart()) {
        const i = index++;
        if (i >= items.length) return;
        await worker(items[i]);
      }
    },
  );

  await Promise.all(runners);
}

/** Phase 1 : nom, genres, tags, avis. Rapide. */
async function enrichMeta(appid: number): Promise<boolean> {
  const db = getDb();
  const meta = await fetchMetadata(appid);

  if (!meta) {
    await db
      .update(gameCache)
      .set({
        enrichAttempts: sql`${gameCache.enrichAttempts} + 1`,
        enrichClaimedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(gameCache.appid, appid));
    return false;
  }

  await db
    .update(gameCache)
    .set({
      name: meta.name,
      genres: meta.genres,
      tags: meta.tags,
      shortDescription: meta.shortDescription,
      // Un logiciel n'est pas un jeu : les listes le masquent (lib/software.ts).
      isSoftware: isSoftwareApp(meta.genres, meta.appType),
      ...(meta.appType ? { appType: meta.appType } : {}),
      updatedAt: new Date(),
      enrichClaimedAt: null,
      // `enrichedAt` marque « identifiable » : le jeu a un vrai nom. La
      // version reste < 2, donc la phase 2 le reprendra pour les prix.
      enrichedAt: new Date(),
      ...(meta.reviewPositive !== null
        ? {
            reviewPositive: meta.reviewPositive,
            reviewNegative: meta.reviewNegative,
            reviewScore: meta.reviewScore,
          }
        : {}),
    })
    .where(eq(gameCache.appid, appid));

  return true;
}

/** Phase 2 : prix Steam, prix des clés, date de sortie, modes de jeu. */
async function enrichPrices(appid: number): Promise<boolean> {
  const db = getDb();

  // Les deux sources sont indépendantes : les interroger en parallèle divise
  // la latence du jeu par deux, sans changer le débit global (limité par hôte).
  const [steamPrice, price] = await Promise.all([
    fetchSteamPrice(appid),
    fetchCheapestPrice(appid),
  ]);

  const gotSomething = Boolean(steamPrice || price);

  await db
    .update(gameCache)
    .set({
      updatedAt: new Date(),
      enrichClaimedAt: null,
      ...(gotSomething
        ? {
            enrichVersion: ENRICH_VERSION,
            enrichAttempts: 0,
            enrichFailed: false,
            priceUpdatedAt: new Date(),
          }
        : {
            enrichAttempts: sql`${gameCache.enrichAttempts} + 1`,
            enrichFailed: true,
          }),
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
            releaseDate: steamPrice.releaseDate,
            playModes: steamPrice.playModes,
            // La jaquette était absente du cache : toutes les pages devaient
            // reconstruire l'URL du CDN. On la stocke quand le Store la donne.
            ...(steamPrice.headerImage ? { headerImage: steamPrice.headerImage } : {}),
          }
        : {}),
    })
    .where(eq(gameCache.appid, appid));

  if (gotSomething) {
    await db.delete(enrichQueue).where(eq(enrichQueue.appid, appid));
  }

  return gotSomething;
}

/**
 * Traite la file pendant au plus `budgetMs`.
 *
 * Les métadonnées prennent ~55 % du budget : elles sont rapides et donnent
 * l'essentiel de ce que l'utilisateur voit. Le reste va aux prix. Quand il ne
 * reste plus de métadonnées, les prix disposent de tout le budget.
 */
export async function runEnrich(opts: EnrichOptions = {}): Promise<EnrichResult> {
  const started = Date.now();
  const budget = opts.budgetMs ?? 15_000;
  const withPrices = opts.withPrices ?? true;

  let metaDone = 0;
  let priceDone = 0;

  // Jeux réclamés par CET appel et pas encore traités : on leur rend la main
  // si l'échéance coupe le travail en cours.
  const claimed = new Set<number>();

  const track = (ids: number[]) => ids.forEach((id) => claimed.add(id));

  try {
    const metaDeadline = started + Math.round(budget * (withPrices ? 0.55 : 1));
    const metaIds = await claimPending('meta', META_CLAIM);
    track(metaIds);

    await runPool(metaIds, metaDeadline, META_CONCURRENCY, META_ESTIMATE_MS, async (appid) => {
      try {
        if (await enrichMeta(appid)) metaDone++;
      } catch (err: any) {
        console.warn('[enrich/meta]', appid, err?.message);
        await releaseClaims([appid]);
      } finally {
        claimed.delete(appid);
      }
    });

    if (withPrices) {
      const priceIds = await claimPending('price', PRICE_CLAIM);
      track(priceIds);

      await runPool(
        priceIds,
        started + budget,
        PRICE_CONCURRENCY,
        PRICE_ESTIMATE_MS,
        async (appid) => {
          try {
            if (await enrichPrices(appid)) priceDone++;
          } catch (err: any) {
            console.warn('[enrich/price]', appid, err?.message);
            await releaseClaims([appid]);
          } finally {
            claimed.delete(appid);
          }
        },
      );
    }
  } finally {
    // Les jeux réservés mais jamais commencés (budget épuisé) sont libérés
    // immédiatement, sinon le prochain passage attendrait 3 minutes.
    if (claimed.size > 0) await releaseClaims([...claimed]).catch(() => {});
  }

  // Hygiène : la file accumulait des jeux déjà enrichis (553 lignes de la
  // veille), que le worker re-scannait à chaque passage pour rien.
  await getDb()
    .execute(sql`
      DELETE FROM enrich_queue q
      USING game_cache c
      WHERE c.appid = q.appid AND c.enriched_at IS NOT NULL
    `)
    .catch(() => undefined);

  const [counts] = (
    await getDb().execute(sql`
      SELECT
        (SELECT count(*)::int FROM game_cache
          WHERE enriched_at IS NULL
            AND (
              enrich_attempts < ${MAX_ATTEMPTS}
              OR (name ~ '^App [0-9]+$' AND enrich_attempts < ${MAX_ATTEMPTS_UNNAMED})
            )) AS meta_pending,
        (SELECT count(*)::int FROM game_cache
          WHERE enriched_at IS NOT NULL
            AND enrich_version < ${ENRICH_VERSION}
            AND enrich_attempts < ${MAX_ATTEMPTS}) AS price_pending
    `)
  ).rows as { meta_pending: number; price_pending: number }[];

  return {
    metaDone,
    priceDone,
    metaPending: Number(counts?.meta_pending ?? 0),
    pricePending: Number(counts?.price_pending ?? 0),
    durationMs: Date.now() - started,
  };
}

/** Libère des réclamations précises (et seulement celles-là). */
async function releaseClaims(appids: number[]) {
  if (appids.length === 0) return;
  await getDb().execute(sql`
    UPDATE game_cache
    SET enrich_claimed_at = NULL
    WHERE appid IN (${sql.join(
      appids.map((id) => sql`${id}`),
      sql`, `,
    )})
  `);
}
