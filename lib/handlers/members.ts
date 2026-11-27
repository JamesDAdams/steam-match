import { getDb } from '../../db/index.ts';
import {
  discordUsers,
  steamLinks,
  users,
  ownedGames,
  gameCache,
  wishlistItems,
} from '../../db/schema.ts';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { optionalAccess } from '../access.ts';
import { guildId, isBotConfigured } from '../discord-bot.ts';
import { getAllExternalGames } from '../external-sync.ts';

/**
 * /api/members — annuaire des membres du serveur Discord.
 *
 * GET                 → liste (identité Discord + Steam + nombre de jeux)
 * GET ?discordId=…    → profil d'un membre et sa ludothèque
 *
 * La liste vient du serveur Discord lui-même (via le bot), pas seulement des
 * personnes déjà connectées au site : un membre qui n'a jamais ouvert le site
 * doit apparaître, avec la mention « profil pas encore créé ».
 *
 * PUBLIC DEPUIS PEU : un visiteur non connecté voit l'annuaire, mais chaque
 * personne décide de ce qui sort de la sphère du site (réglages sur son
 * profil) :
 *   • `gamesPublic`   → ses chiffres (nombre de jeux, temps de jeu) ;
 *   • `profilePublic` → sa fiche et sa ludothèque.
 * Défaut : false / false. Les membres connectés voient toujours tout — ces
 * réglages protègent de l'extérieur, pas du groupe.
 */

const MEMBERS_TTL_MS = 5 * 60_000;
let guildCache: { at: number; value: GuildMember[] } | null = null;

interface GuildMember {
  id: string;
  name: string;
  avatarUrl: string | null;
  joinedAt: string | null;
  bot: boolean;
}

/** Avatar Discord, avec la pastille par défaut quand le compte n'en a pas. */
function discordAvatar(userId: string, avatar: string | null | undefined): string | null {
  if (!avatar) {
    const index = Number((BigInt(userId) >> 22n) % 6n);
    return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
  }
  const ext = avatar.startsWith('a_') ? 'gif' : 'png';
  return `https://cdn.discordapp.com/avatars/${userId}/${avatar}.${ext}?size=128`;
}

async function fetchGuildMembers(): Promise<GuildMember[]> {
  if (guildCache && Date.now() - guildCache.at < MEMBERS_TTL_MS) {
    return guildCache.value;
  }

  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token || !isBotConfigured()) return [];

  try {
    const res = await fetch(
      `https://discord.com/api/v10/guilds/${guildId()}/members?limit=1000`,
      {
        headers: { Authorization: `Bot ${token}` },
        signal: AbortSignal.timeout(8_000),
      },
    );
    if (!res.ok) return [];

    const raw = (await res.json()) as {
      nick?: string | null;
      joined_at?: string | null;
      user: {
        id: string;
        username: string;
        global_name?: string | null;
        avatar?: string | null;
        bot?: boolean;
      };
    }[];

    const value = (Array.isArray(raw) ? raw : [])
      .filter((m) => !m.user?.bot)
      .map((m) => ({
        id: m.user.id,
        name: m.nick || m.user.global_name || m.user.username,
        avatarUrl: discordAvatar(m.user.id, m.user.avatar),
        joinedAt: m.joined_at ?? null,
        bot: Boolean(m.user.bot),
      }));

    guildCache = { at: Date.now(), value };
    return value;
  } catch {
    return [];
  }
}

export default async function handler(req: any, res: any) {
  // Visiteur non connecté : autorisé (annuaire public), mais filtré plus bas.
  const ctx = await optionalAccess(req);
  const viewer: 'member' | 'anonymous' = ctx ? 'member' : 'anonymous';

  try {
    const db = getDb();

    /* ── Profil d'un membre ────────────────────────────────────────── */
    const wanted = typeof req.query?.discordId === 'string' ? req.query.discordId.trim() : '';

    if (wanted) {
      if (!/^\d{17,20}$/.test(wanted)) {
        return res.status(400).json({ error: 'Identifiant Discord invalide.' });
      }

      const [du] = await db
        .select({
          discordId: discordUsers.discordId,
          username: discordUsers.username,
          globalName: discordUsers.globalName,
          avatarUrl: discordUsers.avatarUrl,
          isAdmin: discordUsers.isAdmin,
          lastLoginAt: discordUsers.lastLoginAt,
          gamesPublic: discordUsers.gamesPublic,
          profilePublic: discordUsers.profilePublic,
        })
        .from(discordUsers)
        .where(eq(discordUsers.discordId, wanted))
        .limit(1);

      const [link] = await db
        .select({ steamid: steamLinks.steamid })
        .from(steamLinks)
        .where(eq(steamLinks.discordId, wanted))
        .limit(1);

      // Membre du serveur même sans compte sur le site.
      const guildList = await fetchGuildMembers();
      const fromGuild = guildList.find((m) => m.id === wanted) ?? null;

      if (!du && !fromGuild) {
        return res.status(404).json({ error: 'Ce membre est introuvable.' });
      }

      const isMe = Boolean(ctx && wanted === ctx.discordId);
      // NaN → 0 ; une personne sans compte n'a rien publié.
      const gamesPublic = Boolean(du?.gamesPublic);
      const profilePublic = Boolean(du?.profilePublic);

      const isAnonymous = viewer === 'anonymous';
      // Un membre connecté voit tout ; un visiteur doit y être autorisé.
      const canSeeProfile = !isAnonymous || profilePublic;
      const canSeeMinutes = !isAnonymous || (profilePublic && gamesPublic);

      const identity = {
        discordId: wanted,
        name: du?.globalName || du?.username || fromGuild?.name || `Membre ${wanted.slice(-4)}`,
        avatarUrl: du?.avatarUrl || fromGuild?.avatarUrl || null,
        isAdmin: du?.isAdmin ?? false,
        lastLoginAt: du?.lastLoginAt ?? null,
        joinedAt: fromGuild?.joinedAt ?? null,
        hasAccount: Boolean(du),
        hasSteam: Boolean(link?.steamid),
        gamesPublic,
        profilePublic,
      };

      // Fiche privée : on ne donne RIEN de la ludothèque, même pas les
      // compteurs. Le visiteur sait seulement que le profil existe.
      if (!canSeeProfile) {
        return res.status(200).json({
          ok: true,
          viewer,
          private: true,
          isMe: false,
          showMinutes: false,
          member: identity,
          steam: null,
          stats: null,
          topGenres: [],
          games: [],
          externalGames: [],
          wishlist: [],
          wishlistVisible: false,
        });
      }

      let steam: {
        steamid: string;
        personaName: string;
        avatarUrl: string | null;
        profileUrl: string | null;
        lastSyncAt: Date | null;
      } | null = null;

      let games: any[] = [];
      let stats: {
        totalGames: number;
        playedGames: number;
        totalMinutes: number;
        family: number;
        secondary: number;
      } | null = null;
      let topGenres: { name: string; minutes: number }[] = [];
      let wishlist: any[] = [];
      let externalGames: any[] = [];

      if (link?.steamid) {
        const [u] = await db.select().from(users).where(eq(users.steamid, link.steamid)).limit(1);
        if (u) {
          steam = {
            steamid: u.steamid,
            personaName: u.personaName,
            avatarUrl: u.avatarUrl,
            profileUrl: u.profileUrl,
            lastSyncAt: u.lastSyncAt,
          };
        }

        const rows = await db
          .select({
            appid: ownedGames.appid,
            source: ownedGames.source,
            playtimeForever: ownedGames.playtimeForever,
            playtime2Weeks: ownedGames.playtime2Weeks,
            name: gameCache.name,
            headerImage: gameCache.headerImage,
            genres: gameCache.genres,
            enrichedAt: gameCache.enrichedAt,
            cheapestPrice: gameCache.cheapestPrice,
            cheapestCurrency: gameCache.cheapestCurrency,
            steamPrice: gameCache.steamPrice,
            steamCurrency: gameCache.steamCurrency,
            reviewScore: gameCache.reviewScore,
          })
          .from(ownedGames)
          .leftJoin(gameCache, eq(gameCache.appid, ownedGames.appid))
          .where(
            and(
              eq(ownedGames.steamid, link.steamid),
              sql`COALESCE(${gameCache.isSoftware}, false) = false`,
            ),
          )
          .orderBy(sql`${ownedGames.playtimeForever} DESC`);

        games = rows.map((r) => ({
          appid: r.appid,
          name: r.name ?? `App ${r.appid}`,
          headerImage:
            r.headerImage ??
            `https://cdn.cloudflare.steamstatic.com/steam/apps/${r.appid}/header.jpg`,
          genres: r.genres ?? [],
          enriched: Boolean(r.enrichedAt),
          source: r.source ?? 'owned',
          playtime: r.playtimeForever ?? 0,
          playtime2Weeks: r.playtime2Weeks ?? 0,
          cheapestPrice: r.cheapestPrice ?? null,
          cheapestCurrency: r.cheapestCurrency ?? null,
          steamPrice: r.steamPrice ?? null,
          steamCurrency: r.steamCurrency ?? null,
          reviewScore: r.reviewScore ?? null,
        }));

        const minutes = games.reduce((sum, g) => sum + (g.playtime || 0), 0);
        const played = games.filter((g) => (g.playtime || 0) > 0).length;
        const genreMinutes = new Map<string, number>();
        for (const g of games) {
          for (const genre of g.genres) {
            genreMinutes.set(genre, (genreMinutes.get(genre) ?? 0) + (g.playtime || 0));
          }
        }

        stats = {
          totalGames: games.length,
          playedGames: played,
          totalMinutes: minutes,
          family: games.filter((g) => g.source === 'family').length,
          secondary: games.filter((g) => g.source === 'secondary').length,
        };

        topGenres = [...genreMinutes.entries()]
          .filter(([, m]) => m > 0)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 8)
          .map(([name, minutes]) => ({ name, minutes }));

        // ── Sa wishlist, croisée avec ce que les AUTRES possèdent ──────
        // Réservée aux membres : c'est une liste d'envies personnelle, pas
        // une donnée du profil public.
        if (!isAnonymous) {
          const wishRows = await db
            .select({
              appid: wishlistItems.appid,
              own: wishlistItems.steamid,
              name: gameCache.name,
              headerImage: gameCache.headerImage,
              genres: gameCache.genres,
              steamPrice: gameCache.steamPrice,
              steamCurrency: gameCache.steamCurrency,
              steamDiscount: gameCache.steamDiscount,
              cheapestPrice: gameCache.cheapestPrice,
              cheapestCurrency: gameCache.cheapestCurrency,
              cheapestStore: gameCache.cheapestStore,
              releaseDate: gameCache.releaseDate,
            })
            .from(wishlistItems)
            .leftJoin(gameCache, eq(gameCache.appid, wishlistItems.appid))
            .where(
              and(
                eq(wishlistItems.steamid, link.steamid),
                sql`COALESCE(${gameCache.isSoftware}, false) = false`,
              ),
            )
            .orderBy(desc(wishlistItems.priority));

          if (wishRows.length > 0) {
            const ids = wishRows.map((w) => w.appid);

            const ownerRows = await db
              .select({ appid: ownedGames.appid, steamid: ownedGames.steamid })
              .from(ownedGames)
              .where(inArray(ownedGames.appid, ids));

            const people = await db
              .select({
                steamid: steamLinks.steamid,
                personaName: users.personaName,
                discordName: discordUsers.globalName,
                discordUsername: discordUsers.username,
              })
              .from(steamLinks)
              .innerJoin(users, eq(users.steamid, steamLinks.steamid))
              .leftJoin(discordUsers, eq(discordUsers.discordId, steamLinks.discordId));

            const nameBySteam = new Map(
              people.map((x) => [
                x.steamid,
                x.discordName || x.discordUsername || x.personaName,
              ]),
            );

            const ownersByApp = new Map<number, string[]>();
            for (const row of ownerRows) {
              // Le propriétaire lui-même n'est pas une info : on cherche qui
              // d'AUTRE l'a déjà, c'est ça qui rend le jeu jouable ce soir.
              if (row.steamid === link.steamid) continue;
              const list = ownersByApp.get(row.appid) ?? [];
              list.push(nameBySteam.get(row.steamid) ?? 'Membre');
              ownersByApp.set(row.appid, list);
            }

            wishlist = wishRows.map((w) => {
              const owners = ownersByApp.get(w.appid) ?? [];
              return {
                appid: w.appid,
                name: w.name ?? `App ${w.appid}`,
                headerImage:
                  w.headerImage ??
                  `https://cdn.cloudflare.steamstatic.com/steam/apps/${w.appid}/header.jpg`,
                genres: w.genres ?? [],
                playableNow: owners.length > 0,
                owners,
                steamPrice: w.steamPrice ?? null,
                steamCurrency: w.steamCurrency ?? null,
                steamDiscount: w.steamDiscount ?? null,
                cheapestPrice: w.cheapestPrice ?? null,
                cheapestCurrency: w.cheapestCurrency ?? null,
                cheapestStore: w.cheapestStore ?? null,
                releaseDate: w.releaseDate ?? null,
              };
            });
          }
        }
      }

      // GOG / Epic : la ludothèque du membre est FUSIONNÉE côté site (même
      // présentation que sur son propre profil). On la charge même sans Steam :
      // un membre peut n'avoir qu'un compte GOG ou Epic.
      {
        const ext = await getAllExternalGames(wanted).catch(() => []);
        externalGames =
          isAnonymous && !canSeeMinutes
            ? ext.map((g) => ({ ...g, minutes: 0 }))
            : ext;
      }

      // Chiffres masqués : on retire TOUTES les durées de la réponse, pas
      // seulement à l'affichage — sinon elles restent lisibles dans l'onglet
      // réseau.
      if (!canSeeMinutes) {
        games = games.map((g) => ({ ...g, playtime: 0, playtime2Weeks: 0 }));
        stats = null;
        topGenres = [];
      }

      // Le pseudo Steam et l'identifiant de compte sont des données
      // personnelles : masqués pour les visiteurs non connectés.
      const publicSteam = steam
        ? isAnonymous
          ? null
          : steam
        : null;

      return res.status(200).json({
        ok: true,
        viewer,
        private: false,
        isMe,
        showMinutes: canSeeMinutes,
        wishlistVisible: !isAnonymous,
        member: identity,
        steam: publicSteam,
        stats,
        topGenres,
        games,
        externalGames,
        wishlist,
      });
    }

    /* ── Liste des membres ─────────────────────────────────────────── */
    const guildList = await fetchGuildMembers();

    // Comptes connus du site (même s'ils ont quitté le serveur Discord).
    // Pour un visiteur non connecté, on s'en tient aux membres actuels du
    // serveur : les anciens comptes ne le regardent pas.
    const known = await db
      .select({
        discordId: discordUsers.discordId,
        username: discordUsers.username,
        globalName: discordUsers.globalName,
        avatarUrl: discordUsers.avatarUrl,
        isAdmin: discordUsers.isAdmin,
        gamesPublic: discordUsers.gamesPublic,
        profilePublic: discordUsers.profilePublic,
      })
      .from(discordUsers);

    const knownById = new Map(known.map((k) => [k.discordId, k]));

    const links = await db
      .select({
        discordId: steamLinks.discordId,
        steamid: steamLinks.steamid,
        personaName: users.personaName,
        avatarUrl: users.avatarUrl,
      })
      .from(steamLinks)
      .innerJoin(users, eq(users.steamid, steamLinks.steamid));

    const linkById = new Map(links.map((l) => [l.discordId, l]));

    // Nombre de jeux et temps cumulé, par membre relié à Steam.
    const counts = await db.execute(sql`
      SELECT o.steamid,
             count(*)::int AS games,
             coalesce(sum(o.playtime_forever), 0)::int AS minutes
      FROM owned_games o
      -- Les utilitaires Steam ne comptent pas comme des jeux.
      WHERE NOT EXISTS (
        SELECT 1 FROM game_cache c WHERE c.appid = o.appid AND c.is_software = true
      )
      GROUP BY o.steamid
    `);
    const countBySteam = new Map<string, { games: number; minutes: number }>(
      ((counts.rows ?? counts) as { steamid: string; games: number; minutes: number }[]).map(
        (r) => [r.steamid, { games: Number(r.games), minutes: Number(r.minutes) }],
      ),
    );

    const merged = new Map<
      string,
      {
        discordId: string;
        name: string;
        avatarUrl: string | null;
        isAdmin: boolean;
        joinedAt: string | null;
        hasAccount: boolean;
        gamesPublic: boolean;
        profilePublic: boolean;
        statsVisible: boolean;
        steam: { steamid: string | null; personaName: string | null; avatarUrl: string | null } | null;
        gamesCount: number | null;
        totalMinutes: number | null;
      }
    >();

    for (const m of guildList) {
      const k = knownById.get(m.id);
      const gamesPublic = Boolean(k?.gamesPublic);
      merged.set(m.id, {
        discordId: m.id,
        name: k?.globalName || k?.username || m.name,
        avatarUrl: k?.avatarUrl || m.avatarUrl,
        isAdmin: k?.isAdmin ?? false,
        joinedAt: m.joinedAt,
        hasAccount: Boolean(k),
        gamesPublic,
        profilePublic: Boolean(k?.profilePublic),
        statsVisible: viewer === 'member' || gamesPublic,
        steam: null,
        gamesCount: null,
        totalMinutes: null,
      });
    }

    // Les comptes du site qui ne sont plus dans le serveur restent visibles
    // pour les membres connectés.
    if (viewer === 'member') {
      for (const k of known) {
        if (merged.has(k.discordId)) continue;
        merged.set(k.discordId, {
          discordId: k.discordId,
          name: k.globalName || k.username,
          avatarUrl: k.avatarUrl,
          isAdmin: k.isAdmin,
          joinedAt: null,
          hasAccount: true,
          gamesPublic: Boolean(k.gamesPublic),
          profilePublic: Boolean(k.profilePublic),
          statsVisible: true,
          steam: null,
          gamesCount: null,
          totalMinutes: null,
        });
      }
    }

    for (const entry of merged.values()) {
      const link = linkById.get(entry.discordId);
      if (!link) continue;
      const c = countBySteam.get(link.steamid);
      entry.steam = {
        // Le pseudo Steam n'est pas exposé aux visiteurs non connectés.
        steamid: viewer === 'member' ? link.steamid : null,
        personaName: viewer === 'member' ? link.personaName : null,
        avatarUrl: link.avatarUrl,
      };
      entry.gamesCount = entry.statsVisible ? (c?.games ?? 0) : null;
      entry.totalMinutes = entry.statsVisible ? (c?.minutes ?? 0) : null;
    }

    const members = [...merged.values()].sort((a, b) => {
      // Les profils complets d'abord, puis l'ordre alphabétique.
      const aReady = a.steam ? 1 : 0;
      const bReady = b.steam ? 1 : 0;
      if (aReady !== bReady) return bReady - aReady;
      return a.name.localeCompare(b.name, 'fr');
    });

    return res.status(200).json({
      ok: true,
      viewer,
      members,
      total: members.length,
      withSteam: members.filter((m) => m.steam).length,
      botConfigured: isBotConfigured(),
    });
  } catch (err: any) {
    console.error('[members]', err);
    return res.status(500).json({ error: err.message });
  }
}
