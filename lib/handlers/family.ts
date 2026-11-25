import { requireSteam } from '../access.ts';
import { getDb } from '../../db/index.ts';
import { ownedGames, gameCache, enrichQueue } from '../../db/schema.ts';
import { and, eq, sql } from 'drizzle-orm';
import { rateLimitedFetch } from '../rate-limit.ts';

/**
 * /api/family — jeux rendus jouables par la famille Steam du membre.
 *
 * POURQUOI CETTE ROUTE EST MANUELLE :
 * `IPlayerService/GetOwnedGames` ne renvoie QUE les jeux achetés par le compte.
 * Les jeux empruntés à un groupe familial (Steam Families) en sont absents, et
 * le seul endpoint qui les expose — `IFamilyGroupsService/GetSharedLibraryApps`
 * — exige un `access_token` de session navigateur (JWT qui expire en quelques
 * heures, propre à chaque compte), et non la clé Web API du site : vérifié en
 * direct, la clé répond 401 « Unauthorized » sur cette interface.
 *
 * Aucun serveur ne peut donc les découvrir à la place du membre. On les
 * enregistre à sa demande, à partir d'un lien Steam ou d'un appid, et ils sont
 * marqués `source = 'family'` pour survivre aux synchronisations.
 */

/** Extrait un appid d'un lien Steam, d'un lien steam:// ou d'un identifiant brut. */
export function parseAppid(input: string): number | null {
  const value = input.trim();
  if (!value) return null;

  const direct = /^(\d{1,8})$/.exec(value);
  if (direct) {
    const n = Number(direct[1]);
    return n > 0 ? n : null;
  }

  // https://store.steampowered.com/app/892970/Valheim/ , steam://run/892970 …
  const fromUrl = /(?:store\.steampowered\.com\/app|steam:\/\/(?:run|install))\/(\d{1,8})/i.exec(
    value,
  );
  if (fromUrl) {
    const n = Number(fromUrl[1]);
    return n > 0 ? n : null;
  }

  return null;
}

const STORE = 'https://store.steampowered.com/api/appdetails';

/** Récupère nom et jaquette d'un appid via le Store (1 appel, mis en cache). */
async function fetchStoreBasics(
  appid: number,
): Promise<{ name: string; headerImage: string | null; shortDescription: string | null } | null> {
  try {
    const res = await rateLimitedFetch(
      `${STORE}?appids=${appid}&l=french&filters=basic,short_description`,
      { signal: AbortSignal.timeout(6_000) },
    );
    if (!res.ok) return null;

    const json = (await res.json()) as Record<string, { success?: boolean; data?: any }>;
    const entry = json[String(appid)];
    if (!entry?.success || !entry.data) return null;

    return {
      name: entry.data.name ?? `App ${appid}`,
      headerImage: entry.data.header_image ?? null,
      shortDescription: entry.data.short_description ?? null,
    };
  } catch {
    return null;
  }
}

export default async function handler(req: any, res: any) {
  const method = (req.method || 'GET').toUpperCase();

  const ctx = await requireSteam(req, res);
  if (!ctx) return;

  const { steamid } = ctx;

  try {
    const db = getDb();

    /* ── Liste ─────────────────────────────────────────────────────── */
    if (method === 'GET') {
      const rows = await db.execute(sql`
        SELECT o.appid, o.updated_at, c.name, c.header_image
        FROM owned_games o
        LEFT JOIN game_cache c ON c.appid = o.appid
        WHERE o.steamid = ${steamid} AND o.source = 'family'
        ORDER BY c.name NULLS LAST, o.appid
      `);

      const games = (rows.rows ?? rows) as {
        appid: number;
        name: string | null;
        header_image: string | null;
        updated_at: string;
      }[];

      return res.status(200).json({
        ok: true,
        games: games.map((g) => ({
          appid: g.appid,
          name: g.name ?? `App ${g.appid}`,
          headerImage: g.header_image,
          addedAt: g.updated_at,
        })),
      });
    }

    /* ── Ajout ─────────────────────────────────────────────────────── */
    if (method === 'POST') {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const raw = String(body.value ?? '');
      const appid = parseAppid(raw);

      if (appid === null) {
        return res.status(400).json({
          error:
            'Colle un lien Steam (https://store.steampowered.com/app/…) ou un identifiant de jeu.',
        });
      }

      // Déjà possédé : inutile de l'ajouter en « famille ».
      const [owned] = await db
        .select({ appid: ownedGames.appid, source: ownedGames.source })
        .from(ownedGames)
        .where(and(eq(ownedGames.steamid, steamid), eq(ownedGames.appid, appid)))
        .limit(1);

      if (owned?.source === 'owned') {
        return res
          .status(409)
          .json({ error: 'Tu possèdes déjà ce jeu, inutile de l’ajouter.' });
      }
      if (owned?.source === 'family') {
        return res.status(200).json({ ok: true, already: true, appid });
      }

      // On complète le cache si le jeu n'y est pas encore : sinon la liste
      // afficherait « App 892970 ».
      const [cached] = await db
        .select({ name: gameCache.name, headerImage: gameCache.headerImage })
        .from(gameCache)
        .where(eq(gameCache.appid, appid))
        .limit(1);

      if (!cached?.name) {
        const basics = await fetchStoreBasics(appid);
        if (!basics) {
          return res.status(400).json({
            error:
              'Jeu introuvable sur le Store Steam. Vérifie le lien (ou réessaie dans un instant).',
          });
        }

        await db
          .insert(gameCache)
          .values({
            appid,
            name: basics.name,
            headerImage: basics.headerImage,
            shortDescription: basics.shortDescription,
          })
          .onConflictDoUpdate({
            target: gameCache.appid,
            set: {
              name: basics.name,
              headerImage: sql`COALESCE(${gameCache.headerImage}, ${basics.headerImage})`,
              shortDescription: sql`COALESCE(${gameCache.shortDescription}, ${basics.shortDescription})`,
            },
          });

        // Le reste (genres, prix, avis) sera complété par le worker existant.
        await db
          .insert(enrichQueue)
          .values({ appid, priority: 5 })
          .onConflictDoNothing();
      }

      await db
        .insert(ownedGames)
        .values({ steamid, appid, playtimeForever: 0, playtime2Weeks: 0, source: 'family' })
        .onConflictDoUpdate({
          target: [ownedGames.steamid, ownedGames.appid],
          // Un jeu possédé le reste : on ne le rétrograde pas en « famille ».
          set: { source: sql`CASE WHEN owned_games.source = 'owned' THEN 'owned' ELSE 'family' END` },
        });

      const [row] = await db
        .select({ name: gameCache.name, headerImage: gameCache.headerImage })
        .from(gameCache)
        .where(eq(gameCache.appid, appid))
        .limit(1);

      return res.status(201).json({
        ok: true,
        game: {
          appid,
          name: row?.name ?? `App ${appid}`,
          headerImage: row?.headerImage ?? null,
        },
      });
    }

    /* ── Retrait ───────────────────────────────────────────────────── */
    if (method === 'DELETE') {
      const appid = Number((req.body ?? {}).appid ?? req.query?.appid);
      if (!Number.isInteger(appid) || appid <= 0) {
        return res.status(400).json({ error: 'Identifiant de jeu invalide.' });
      }

      const deleted = await db
        .delete(ownedGames)
        .where(
          and(
            eq(ownedGames.steamid, steamid),
            eq(ownedGames.appid, appid),
            eq(ownedGames.source, 'family'),
          ),
        )
        .returning({ appid: ownedGames.appid });

      return res.status(200).json({ ok: true, removed: deleted.length });
    }

    return res.status(405).json({ error: `Méthode ${method} non supportée.` });
  } catch (err: any) {
    console.error('[family]', err);
    return res.status(500).json({ error: err.message });
  }
}
