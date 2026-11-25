import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from '../db/index';
import { ownedGames, gameCache, users } from '../db/schema';
import { sql } from 'drizzle-orm';
import { requireAccess } from '../lib/access';

/**
 * GET /api/recommendations?excludeOwned=1&limit=20
 *
 * PRINCIPE
 * --------
 * 1. Pour chaque membre, on construit un vecteur d'affinité par genre et par
 *    tag, PONDÉRÉ PAR LE TEMPS DE JEU. Quelqu'un qui a 500 h sur des jeux de
 *    survie pèse beaucoup plus lourd que 2 h.
 *
 *    Pondération logarithmique : log1p(minutes). Sans ça, un unique jeu à
 *    2000 h écrase complètement tous les autres signaux et le profil devient
 *    mono-genre. Le log garde l'ordre tout en limitant la domination.
 *
 * 2. On croise tous les vecteurs du groupe. Pour chaque jeu candidat, on
 *    calcule le score de CHAQUE membre, puis on retient le score MINIMUM.
 *    C'est le point clé : on cherche ce qui plaît à TOUT LE MONDE, pas ce qui
 *    plaît à un seul. Une moyenne favoriserait les jeux adorés par une
 *    personne et indifférents pour les autres.
 *
 * 3. Candidats = jeux du cache enrichi qui ne sont pas déjà possédés par tout
 *    le monde. Un jeu possédé par personne n'est pas proposé (trop cher à
 *    acheter) ; un jeu possédé par tous n'est plus une découverte.
 *
 * LIMITES (à assumer, pas à cacher)
 * ----------------------------------
 * - Sans temps de jeu (profil non public), l'affinité retombe sur une simple
 *   présence/absence : le signal est beaucoup plus faible et les propositions
 *   seront génériques.
 * - Le catalogue de candidats se limite aux jeux déjà vus chez au moins un
 *   membre. Steam n'expose pas d'endpoint «Top des ventes» sans clé
 *   partenaire, donc on ne peut pas proposer des jeux totalement inconnus du
 *   groupe.
 */

const DEFAULT_LIMIT = 20;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const ctx = await requireAccess(req, res);
  if (!ctx) return;

  try {
    const db = getDb();

    const limitRaw = Number(req.query.limit ?? DEFAULT_LIMIT);
    const limit = Number.isFinite(limitRaw)
      ? Math.max(1, Math.min(100, limitRaw))
      : DEFAULT_LIMIT;
    const excludeOwned = req.query.excludeOwned !== '0';

    // 1. Toutes les possessions + temps de jeu.
    const owned = await db.execute(sql`
      SELECT og.steamid, og.appid, og.playtime_forever
      FROM owned_games og
    `);

    const ownedRows = owned.rows as { steamid: string; appid: number; playtime_forever: number }[];
    if (ownedRows.length === 0) {
      return res.status(200).json({
        ok: true,
        recommendations: [],
        message: 'Personne n\u2019a encore synchronisé sa ludothèque.',
      });
    }

    // 2. Métadonnées enrichies (genres/tags) — sans elles, pas de scoring.
    const metas = await db
      .select()
      .from(gameCache);

    const metaById = new Map(metas.map((m) => [m.appid, m]));
    const enrichedMeta = new Map(
      [...metaById.entries()].filter(([, m]) => m.enrichedAt && (m.genres.length > 0 || m.tags.length > 0)),
    );

    if (enrichedMeta.size === 0) {
      const [pending] = await db
        .select({ n: sql<number>`count(*) filter (where ${gameCache.enrichedAt} is null)::int` })
        .from(gameCache);
      return res.status(200).json({
        ok: true,
        recommendations: [],
        needsEnrichment: true,
        pendingCount: pending?.n ?? 0,
        message:
          'Aucun jeu enrichi pour l\u2019instant. Lance /api/enrich plusieurs fois ' +
          'pour récupérer les genres depuis le Store Steam.',
      });
    }

    // 3. Vecteurs d'affinité par utilisateur.
    const affinity = new Map<string, Map<string, number>>();
    const ownedByUser = new Map<string, Set<number>>();
    const ownedByApp = new Map<number, Set<string>>();

    for (const row of ownedRows) {
      const appid = Number(row.appid);
      const meta = enrichedMeta.get(appid);
      if (!meta) continue;

      const weight = Math.log1p(Number(row.playtime_forever ?? 0) / 60); // heures
      const terms = [...meta.genres, ...meta.tags];
      if (terms.length === 0) continue;

      if (!affinity.has(row.steamid)) affinity.set(row.steamid, new Map());
      if (!ownedByUser.has(row.steamid)) ownedByUser.set(row.steamid, new Set());
      if (!ownedByApp.has(appid)) ownedByApp.set(appid, new Set());

      ownedByUser.get(row.steamid)!.add(appid);
      ownedByApp.get(appid)!.add(row.steamid);

      const vec = affinity.get(row.steamid)!;
      for (const t of terms) {
        const k = norm(t);
        vec.set(k, (vec.get(k) ?? 0) + weight);
      }
    }

    // Normalisation : sinon celui qui possède 500 jeux domine mécaniquement
    // celui qui en a 40. On ramène chaque vecteur à une norme unitaire.
    for (const [, vec] of affinity) {
      let sum = 0;
      for (const v of vec.values()) sum += v * v;
      const n = Math.sqrt(sum);
      if (n > 0) for (const [k, v] of vec) vec.set(k, v / n);
    }

    const memberIds = [...affinity.keys()];
    const names = await db.select().from(users);
    const nameById = new Map(names.map((u) => [u.steamid, u.personaName]));

    const gamesVisible = names.filter((u) => u.gamesVisible).length;
    const totalMembers = names.length;

    // 4. Scoring des candidats.
    const candidates: {
      appid: number;
      name: string;
      headerImage: string | null;
      genres: string[];
      tags: string[];
      score: number;
      minScore: number;
      perMember: { steamid: string; personaName: string; score: number; owned: boolean }[];
      owners: number;
    }[] = [];

    for (const [appid, meta] of enrichedMeta) {
      const ownerSet = ownedByApp.get(appid) ?? new Set<string>();

      // Exclut les jeux déjà possédés par TOUT le monde (plus une découverte).
      if (excludeOwned && ownerSet.size >= memberIds.length) continue;
      // Exclut les jeux que personne ne possède : hors de portée du scoring.
      if (ownerSet.size === 0) continue;

      const terms = [...meta.genres, ...meta.tags].map(norm);
      if (terms.length === 0) continue;

      const perMember = memberIds.map((sid) => {
        const vec = affinity.get(sid)!;
        let s = 0;
        for (const t of terms) s += vec.get(t) ?? 0;
        return {
          steamid: sid,
          personaName: nameById.get(sid) ?? `Joueur ${sid.slice(-4)}`,
          score: s,
          owned: ownerSet.has(sid),
        };
      });

      const minScore = Math.min(...perMember.map((p) => p.score));
      // Léger bonus au nombre de possesseurs : un jeu que plusieurs ont déjà
      // est plus facile à lancer ensemble.
      const score = minScore + 0.05 * ownerSet.size;

      candidates.push({
        appid,
        name: meta.name,
        headerImage: meta.headerImage ?? null,
        genres: meta.genres,
        tags: meta.tags,
        score,
        minScore,
        perMember,
        owners: ownerSet.size,
      });
    }

    candidates.sort((a, b) => b.score - a.score);
    const top = candidates.slice(0, limit);

    return res.status(200).json({
      ok: true,
      recommendations: top,
      meta: {
        members: totalMembers,
        membersWithPlaytime: gamesVisible,
        // Signal dégradé : sans temps de jeu, les recommandations sont faibles.
        weakSignal: gamesVisible < Math.max(2, Math.ceil(totalMembers / 2)),
        enrichedGames: enrichedMeta.size,
        candidateCount: candidates.length,
      },
    });
  } catch (err: any) {
    console.error('[recommendations]', err);
    return res.status(500).json({ error: err.message });
  }
}

function norm(s: string) {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}
