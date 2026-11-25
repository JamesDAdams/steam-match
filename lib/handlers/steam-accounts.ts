import { requireSteam } from '../access.ts';
import { getDb } from '../../db/index.ts';
import { ownedGames, steamAccounts } from '../../db/schema.ts';
import { and, eq, sql } from 'drizzle-orm';
import { getPlayerSummaries } from '../steam.ts';
import { absorbLibrary } from '../steam-library.ts';

/**
 * /api/steam-accounts — comptes Steam secondaires et familiaux d'un membre.
 *
 * POURQUOI CETTE PAGE EXISTE :
 * `IPlayerService/GetOwnedGames` ne renvoie que les jeux achetés par UN compte.
 * Un joueur qui possède un second compte, ou qui profite de la bibliothèque de
 * sa famille Steam, voyait donc des jeux manquants dans sa ludothèque — sans
 * aucun moyen de les récupérer côté serveur : l'interface qui les expose
 * (`IFamilyGroupsService`) exige un jeton de session navigateur, pas notre clé
 * Web API (vérifié : HTTP 401).
 *
 * On déclare donc les comptes, on aspire leur ludothèque **publique**, et
 * chaque jeu garde l'origine de son compte (`source` + `source_steamid`) pour
 * être étiqueté dans la ludothèque.
 */

const MAX_ACCOUNTS = 5;

/** Extrait un SteamID64 d'un lien de profil, d'un vanity ou d'un identifiant brut. */
function parseSteamId(input: string): { steamid?: string; vanity?: string } {
  const value = input.trim();
  if (!value) return {};

  const direct = /^(\d{17})$/.exec(value);
  if (direct) return { steamid: direct[1] };

  const profile = /steamcommunity\.com\/profiles\/(\d{17})/i.exec(value);
  if (profile) return { steamid: profile[1] };

  const vanity = /steamcommunity\.com\/id\/([A-Za-z0-9_.-]{2,64})/i.exec(value);
  if (vanity) return { vanity: vanity[1] };

  // Dernier recours : « pseudo » seul, qu'on tentera comme URL personnalisée.
  if (/^[A-Za-z0-9_.-]{2,64}$/.test(value)) return { vanity: value };

  return {};
}

/** Résout une URL personnalisée en SteamID64 via la Web API. */
async function resolveVanity(vanity: string): Promise<string | null> {
  const key = process.env.STEAM_API_KEY;
  if (!key) return null;

  try {
    const url = `https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/?key=${key}&vanityurl=${encodeURIComponent(vanity)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(6_000) });
    if (!res.ok) return null;

    const json = (await res.json()) as { response?: { success?: number; steamid?: string } };
    return json.response?.success === 1 ? (json.response.steamid ?? null) : null;
  } catch {
    return null;
  }
}

export default async function handler(req: any, res: any) {
  const method = (req.method || 'GET').toUpperCase();

  const ctx = await requireSteam(req, res);
  if (!ctx) return;

  const owner = ctx.steamid;

  try {
    const db = getDb();

    /* ── Liste ─────────────────────────────────────────────────────── */
    if (method === 'GET') {
      const accounts = await db
        .select()
        .from(steamAccounts)
        .where(eq(steamAccounts.ownerSteamid, owner));

      // Nombre de jeux réellement attribués à chaque compte, pour détecter un
      // décalage avec le compteur mémorisé.
      const counts = await db.execute(sql`
        SELECT source_steamid, count(*)::int AS n
        FROM owned_games
        WHERE steamid = ${owner} AND source_steamid IS NOT NULL
        GROUP BY source_steamid
      `);
      const byLink = new Map<string, number>(
        ((counts.rows ?? counts) as { source_steamid: string; n: number }[]).map((r) => [
          r.source_steamid,
          r.n,
        ]),
      );

      return res.status(200).json({
        ok: true,
        maxAccounts: MAX_ACCOUNTS,
        accounts: accounts.map((a) => ({
          steamid: a.steamid,
          kind: a.kind === 'secondary' ? 'secondary' : 'family',
          personaName: a.personaName,
          avatarUrl: a.avatarUrl,
          gamesCount: byLink.get(a.steamid) ?? 0,
          lastSyncedAt: a.lastSyncedAt,
          lastError: a.lastError,
          profileUrl: `https://steamcommunity.com/profiles/${a.steamid}`,
        })),
      });
    }

    /* ── Ajout / resynchronisation ─────────────────────────────────── */
    if (method === 'POST') {
      const body = (req.body ?? {}) as Record<string, unknown>;

      // Resynchronisation d'un compte déjà lié.
      const resync = typeof body.steamid === 'string' ? body.steamid.trim() : '';
      if (resync) {
        const [existing] = await db
          .select()
          .from(steamAccounts)
          .where(
            and(
              eq(steamAccounts.ownerSteamid, owner),
              eq(steamAccounts.steamid, resync),
            ),
          )
          .limit(1);

        if (!existing) {
          return res.status(404).json({ error: 'Ce compte n’est pas lié à ton profil.' });
        }

        try {
          const { count } = await absorbLibrary(
            owner,
            existing.steamid,
            existing.kind === 'secondary' ? 'secondary' : 'family',
          );
          await db
            .update(steamAccounts)
            .set({ gamesCount: count, lastSyncedAt: new Date(), lastError: null })
            .where(
              and(
                eq(steamAccounts.ownerSteamid, owner),
                eq(steamAccounts.steamid, existing.steamid),
              ),
            );
          return res.status(200).json({ ok: true, gamesCount: count });
        } catch (err: any) {
          await db
            .update(steamAccounts)
            .set({ lastError: err.message })
            .where(
              and(
                eq(steamAccounts.ownerSteamid, owner),
                eq(steamAccounts.steamid, existing.steamid),
              ),
            );
          return res.status(400).json({ error: err.message });
        }
      }

      // Ajout d'un nouveau compte.
      const kind = body.kind === 'secondary' ? 'secondary' : 'family';
      const parsed = parseSteamId(String(body.value ?? ''));

      let steamid = parsed.steamid ?? null;
      if (!steamid && parsed.vanity) {
        steamid = await resolveVanity(parsed.vanity);
      }
      if (!steamid) {
        return res.status(400).json({
          error:
            'Compte Steam introuvable. Colle un lien de profil (steamcommunity.com/profiles/…) ' +
            'ou ton identifiant d’URL personnalisée.',
        });
      }
      if (steamid === owner) {
        return res
          .status(400)
          .json({ error: 'C’est déjà ton compte principal, synchronisé automatiquement.' });
      }

      const existing = await db
        .select({ steamid: steamAccounts.steamid })
        .from(steamAccounts)
        .where(eq(steamAccounts.ownerSteamid, owner));

      if (existing.some((a) => a.steamid === steamid)) {
        return res.status(409).json({ error: 'Ce compte est déjà lié à ton profil.' });
      }
      if (existing.length >= MAX_ACCOUNTS) {
        return res
          .status(400)
          .json({ error: `Tu ne peux pas lier plus de ${MAX_ACCOUNTS} comptes.` });
      }

      // Identité (pseudo + avatar) : purement cosmétique, ne bloque pas.
      let personaName: string | null = null;
      let avatarUrl: string | null = null;
      try {
        const summaries = await getPlayerSummaries([steamid]);
        const summary = summaries.get(steamid);
        personaName = summary?.personaName ?? null;
        avatarUrl = summary?.avatarUrl ?? null;
      } catch {
        /* on garde le SteamID comme libellé */
      }

      try {
        const { count } = await absorbLibrary(owner, steamid, kind);

        await db
          .insert(steamAccounts)
          .values({
            ownerSteamid: owner,
            steamid,
            kind,
            personaName,
            avatarUrl,
            gamesCount: count,
            lastSyncedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [steamAccounts.ownerSteamid, steamAccounts.steamid],
            set: {
              kind,
              personaName,
              avatarUrl,
              gamesCount: count,
              lastSyncedAt: new Date(),
              lastError: null,
            },
          });

        return res.status(201).json({
          ok: true,
          account: {
            steamid,
            kind,
            personaName,
            avatarUrl,
            gamesCount: count,
            lastSyncedAt: new Date(),
            profileUrl: `https://steamcommunity.com/profiles/${steamid}`,
          },
        });
      } catch (err: any) {
        // On mémorise l'échec pour que la page puisse l'expliquer, sans créer
        // de compte fantôme s'il n'y avait aucun jeu exploitable.
        await db
          .insert(steamAccounts)
          .values({
            ownerSteamid: owner,
            steamid,
            kind,
            personaName,
            avatarUrl,
            gamesCount: 0,
            lastError: err.message,
          })
          .onConflictDoUpdate({
            target: [steamAccounts.ownerSteamid, steamAccounts.steamid],
            set: { kind, lastError: err.message },
          });

        return res.status(400).json({ error: err.message });
      }
    }

    /* ── Retrait ───────────────────────────────────────────────────── */
    if (method === 'DELETE') {
      const steamid = String((req.body ?? {}).steamid ?? req.query?.steamid ?? '').trim();
      if (!/^\d{17}$/.test(steamid)) {
        return res.status(400).json({ error: 'Compte Steam invalide.' });
      }

      const deleted = await db
        .delete(steamAccounts)
        .where(
          and(eq(steamAccounts.ownerSteamid, owner), eq(steamAccounts.steamid, steamid)),
        )
        .returning({ steamid: steamAccounts.steamid });

      // Ses jeux partent aussi : sinon la ludothèque garderait des jeux
      // orphelins étiquetés d'un compte qui n'existe plus.
      await db
        .delete(ownedGames)
        .where(
          and(eq(ownedGames.steamid, owner), eq(ownedGames.sourceSteamid, steamid)),
        );

      return res.status(200).json({ ok: true, removed: deleted.length > 0 });
    }

    return res.status(405).json({ error: `Méthode ${method} non supportée.` });
  } catch (err: any) {
    console.error('[steam-accounts]', err);
    return res.status(500).json({ error: err.message });
  }
}
