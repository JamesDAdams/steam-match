import { getDb } from '../db/index.ts';
import { steamAccounts, steamLinks, users } from '../db/schema.ts';
import { eq } from 'drizzle-orm';
import { absorbLibrary, syncOwnedLibrary } from './steam-library.ts';

/**
 * Rafraîchissement périodique de TOUTES les ludothèques Steam :
 * compte principal, comptes secondaires et comptes famille.
 *
 * POURQUOI UN WORKER PLUTÔT QU'UNE BOUCLE DANS LE CRON :
 * chaque compte coûte deux appels Steam (~1 s). Un seul passage ne peut donc
 * pas traiter tout le monde dans les 10 s accordées aux fonctions planifiées :
 * on traite les comptes les plus anciennement synchronisés, dans un budget de
 * temps, et la suite part au passage suivant. Les comptes tournent ainsi sans
 * jamais bloquer ni se faire exclure par Steam.
 */

export interface SteamSyncJobResult {
  kind: 'main' | 'secondary' | 'family';
  steamid: string;
  owner: string;
  ok: boolean;
  gamesCount?: number;
  error?: string;
}

export interface SteamSyncReport {
  handled: number;
  failed: number;
  remaining: number;
  durationMs: number;
  results: SteamSyncJobResult[];
}

interface Job {
  kind: 'main' | 'secondary' | 'family';
  /** Compte Steam à interroger. */
  steamid: string;
  /** Membre auquel rattacher les jeux (identique pour un compte principal). */
  owner: string;
  lastSyncAt: Date | null;
}

export async function runSteamSync(
  opts: { budgetMs?: number } = {},
): Promise<SteamSyncReport> {
  const budgetMs = opts.budgetMs ?? 8_000;
  const started = Date.now();
  const db = getDb();

  // ── Comptes principaux liés au site ────────────────────────────────
  const mains = await db
    .select({ steamid: steamLinks.steamid, lastSyncAt: users.lastSyncAt })
    .from(steamLinks)
    .innerJoin(users, eq(users.steamid, steamLinks.steamid));

  // ── Comptes secondaires / famille déclarés ─────────────────────────
  const linked = await db.select().from(steamAccounts);

  const jobs: Job[] = [
    ...mains.map((m) => ({
      kind: 'main' as const,
      steamid: m.steamid,
      owner: m.steamid,
      lastSyncAt: m.lastSyncAt ?? null,
    })),
    ...linked.map((a) => ({
      kind: (a.kind === 'secondary' ? 'secondary' : 'family') as 'secondary' | 'family',
      steamid: a.steamid,
      owner: a.ownerSteamid,
      lastSyncAt: a.lastSyncedAt ?? null,
    })),
  ];

  // Les plus anciens d'abord (jamais synchronisés en premier).
  jobs.sort((a, b) => (a.lastSyncAt?.getTime() ?? 0) - (b.lastSyncAt?.getTime() ?? 0));

  const results: SteamSyncJobResult[] = [];
  let handled = 0;
  let failed = 0;

  for (const job of jobs) {
    // On garde une marge pour l'écriture en base et la réponse HTTP.
    if (Date.now() - started > budgetMs) break;

    try {
      if (job.kind === 'main') {
        const r = await syncOwnedLibrary(job.steamid);
        results.push({
          kind: job.kind,
          steamid: job.steamid,
          owner: job.owner,
          ok: !r.empty,
          gamesCount: r.gamesCount,
          error: r.empty ? 'Ludothèque vide ou profil privé' : undefined,
        });
        if (r.empty) failed++;
        else handled++;
      } else {
        const { count } = await absorbLibrary(job.owner, job.steamid, job.kind);
        await db
          .update(steamAccounts)
          .set({ gamesCount: count, lastSyncedAt: new Date(), lastError: null })
          .where(eq(steamAccounts.steamid, job.steamid));
        results.push({
          kind: job.kind,
          steamid: job.steamid,
          owner: job.owner,
          ok: true,
          gamesCount: count,
        });
        handled++;
      }
    } catch (err: any) {
      failed++;
      results.push({
        kind: job.kind,
        steamid: job.steamid,
        owner: job.owner,
        ok: false,
        error: err?.message ?? String(err),
      });

      // On mémorise l'échec sur le compte lié pour l'afficher dans le profil.
      if (job.kind !== 'main') {
        await db
          .update(steamAccounts)
          .set({ lastError: (err?.message ?? String(err)).slice(0, 300), lastSyncedAt: new Date() })
          .where(eq(steamAccounts.steamid, job.steamid))
          .catch(() => undefined);
      }
    }
  }

  return {
    handled,
    failed,
    remaining: Math.max(0, jobs.length - results.length),
    durationMs: Date.now() - started,
    results,
  };
}

/** Nombre de comptes suivis — affiché dans l'admin pour situer le réglage. */
export async function countTrackedAccounts(): Promise<{ main: number; linked: number }> {
  const db = getDb();
  const mains = await db.select({ steamid: steamLinks.steamid }).from(steamLinks);
  const linked = await db.select({ steamid: steamAccounts.steamid }).from(steamAccounts);
  return { main: mains.length, linked: linked.length };
}
