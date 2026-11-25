import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from '../db/index.ts';
import {
  discordUsers,
  steamLinks,
  users,
  ownedGames,
  gameCache,
  wishlistItems,
} from '../db/schema.ts';
import { eq, desc, inArray } from 'drizzle-orm';
import {
  COOKIE_NAME,
  parseCookies,
  readSession,
  destroySession,
  clearCookie,
} from '../lib/session.ts';
import { isAdminId } from '../lib/discord.ts';
import { resolveAccess } from '../lib/access.ts';
import { inviteUrl, isBotConfigured } from '../lib/discord-bot.ts';
import { recommendationsEnabled } from '../lib/features.ts';

/**
 * GET  /api/me  → état complet de la session
 * POST /api/me  → déconnexion
 *
 * Le logout est fusionné ici volontairement : le plan Hobby de Vercel limite
 * un déploiement à 12 fonctions serverless. Chaque fichier de /api en consomme
 * une, donc on regroupe les routes de moindre importance.
 *
 * GET ne répond jamais 401/403 : le front doit distinguer « pas connecté »,
 * « connecté mais pas autorisé » et « connecté et autorisé ».
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const cookies = parseCookies(req.headers.cookie);

  // ── Déconnexion ──────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const raw = cookies[COOKIE_NAME];
    if (raw) {
      const token = raw.slice(0, raw.lastIndexOf('.'));
      await destroySession(token).catch(() => {});
    }
    res.setHeader('Set-Cookie', clearCookie());
    return res.status(200).json({ ok: true });
  }

  // ── État de la session ───────────────────────────────────────────────
  try {
    const sess = await readSession(cookies[COOKIE_NAME]);

    if (!sess) {
      return res.status(200).json({
        ok: true,
        authenticated: false,
        // Infos publiques utiles à la page de connexion (lien du serveur).
        guildInviteUrl: inviteUrl(),
        botConfigured: isBotConfigured(),
      });
    }

    const db = getDb();
    const [du] = await db
      .select()
      .from(discordUsers)
      .where(eq(discordUsers.discordId, sess.discordId))
      .limit(1);

    if (!du) {
      return res.status(200).json({
        ok: true,
        authenticated: false,
        guildInviteUrl: inviteUrl(),
        botConfigured: isBotConfigured(),
      });
    }

    const admin = isAdminId(du.discordId);

    // Autorisation : admin (env), membre du serveur Discord, ou exception
    // ajoutée depuis la page admin. Même fonction que requireAccess(), pour
    // que l'affichage et la sécurité ne puissent pas diverger.
    const decision = await resolveAccess(du.discordId);
    const allowed = decision.allowed;

    // Liaison Steam.
    let steam: null | {
      steamid: string;
      personaName: string;
      avatarUrl: string | null;
      profileVisible: boolean;
      gamesVisible: boolean;
      lastSyncAt: Date | null;
    } = null;

    const [link] = await db
      .select()
      .from(steamLinks)
      .where(eq(steamLinks.discordId, du.discordId))
      .limit(1);

    if (link?.steamid) {
      const [u] = await db
        .select()
        .from(users)
        .where(eq(users.steamid, link.steamid))
        .limit(1);
      if (u) {
        steam = {
          steamid: u.steamid,
          personaName: u.personaName,
          // Affiché dans la page profil, à côté des comptes liés : sans lui, le
          // compte principal n'avait pas d'avatar alors que les autres oui.
          avatarUrl: u.avatarUrl,
          profileVisible: u.profileVisible,
          gamesVisible: u.gamesVisible,
          lastSyncAt: u.lastSyncAt,
        };
      }
    }

    // ── Jeux et temps de jeu (page profil) ─────────────────────────────
    // Chargé uniquement sur demande (?games=1) : la requête peut renvoyer
    // plusieurs centaines de lignes, inutile de l'imposer à chaque appel.
    let games: any[] | null = null;
    let stats: any | null = null;
    let wishlist: any[] = [];

    if (req.query.games === '1' && steam) {
      const rows = await db
        .select({
          appid: ownedGames.appid,
          source: ownedGames.source,
          sourceSteamid: ownedGames.sourceSteamid,
          playtimeForever: ownedGames.playtimeForever,
          playtime2Weeks: ownedGames.playtime2Weeks,
          name: gameCache.name,
          headerImage: gameCache.headerImage,
          genres: gameCache.genres,
          tags: gameCache.tags,
          enrichedAt: gameCache.enrichedAt,
          cheapestPrice: gameCache.cheapestPrice,
          cheapestStore: gameCache.cheapestStore,
          cheapestCurrency: gameCache.cheapestCurrency,
          steamPrice: gameCache.steamPrice,
          steamInitialPrice: gameCache.steamInitialPrice,
          steamDiscount: gameCache.steamDiscount,
          steamCurrency: gameCache.steamCurrency,
          reviewScore: gameCache.reviewScore,
          reviewPositive: gameCache.reviewPositive,
          reviewNegative: gameCache.reviewNegative,
          releaseDate: gameCache.releaseDate,
          playModes: gameCache.playModes,
        })
        .from(ownedGames)
        .leftJoin(gameCache, eq(gameCache.appid, ownedGames.appid))
        .where(eq(ownedGames.steamid, steam.steamid))
        .orderBy(desc(ownedGames.playtimeForever));

      games = rows.map((r) => ({
        appid: r.appid,
        name: r.name ?? `App ${r.appid}`,
        headerImage: r.headerImage ?? null,
        genres: r.genres ?? [],
        tags: r.tags ?? [],
        enriched: Boolean(r.enrichedAt),
        // Origine du jeu : « owned », « secondary » ou « family » — affiché
        // comme étiquette dans la ludothèque.
        source: r.source ?? 'owned',
        sourceSteamid: r.sourceSteamid ?? null,
        playtime: r.playtimeForever ?? 0,
        playtime2Weeks: r.playtime2Weeks ?? 0,
        cheapestPrice: r.cheapestPrice ?? null,
        cheapestStore: r.cheapestStore ?? null,
        cheapestCurrency: r.cheapestCurrency ?? null,
        steamPrice: r.steamPrice ?? null,
        steamInitialPrice: r.steamInitialPrice ?? null,
        steamDiscount: r.steamDiscount ?? null,
        steamCurrency: r.steamCurrency ?? null,
        reviewScore: r.reviewScore ?? null,
        reviewPositive: r.reviewPositive ?? null,
        reviewNegative: r.reviewNegative ?? null,
        releaseDate: r.releaseDate ?? null,
        playModes: r.playModes ?? [],
      }));

      stats = buildStats(games);

      // ── Wishlist personnelle ────────────────────────────────────────
      // Croisée avec ce que les AUTRES membres possèdent déjà : c'est
      // l'information utile (« lui le veut, toi tu l'as »).
      const wishRows = await db
        .select({
          appid: wishlistItems.appid,
          priority: wishlistItems.priority,
          name: gameCache.name,
          headerImage: gameCache.headerImage,
          genres: gameCache.genres,
          enrichedAt: gameCache.enrichedAt,
          cheapestPrice: gameCache.cheapestPrice,
          cheapestStore: gameCache.cheapestStore,
          cheapestCurrency: gameCache.cheapestCurrency,
          steamPrice: gameCache.steamPrice,
          steamInitialPrice: gameCache.steamInitialPrice,
          steamDiscount: gameCache.steamDiscount,
          steamCurrency: gameCache.steamCurrency,
          reviewScore: gameCache.reviewScore,
          reviewPositive: gameCache.reviewPositive,
          reviewNegative: gameCache.reviewNegative,
          releaseDate: gameCache.releaseDate,
          playModes: gameCache.playModes,
        })
        .from(wishlistItems)
        .leftJoin(gameCache, eq(gameCache.appid, wishlistItems.appid))
        .where(eq(wishlistItems.steamid, steam.steamid))
        .orderBy(desc(wishlistItems.priority));

      if (wishRows.length > 0) {
        const ids = wishRows.map((w) => w.appid);

        const ownerRows = await db
          .select({
            appid: ownedGames.appid,
            steamid: ownedGames.steamid,
          })
          .from(ownedGames)
          .where(inArray(ownedGames.appid, ids));

        // Noms affichés des membres.
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

        const nameById = new Map(
          people.map((x) => [
            x.steamid,
            x.discordName || x.discordUsername || x.personaName,
          ]),
        );

        const ownersByApp = new Map<number, string[]>();
        for (const row of ownerRows) {
          const list = ownersByApp.get(row.appid) ?? [];
          list.push(nameById.get(row.steamid) ?? 'Membre');
          ownersByApp.set(row.appid, list);
        }

        wishlist = wishRows.map((w) => {
          const owners = ownersByApp.get(w.appid) ?? [];
          return {
            appid: w.appid,
            name: w.name ?? `App ${w.appid}`,
            headerImage: w.headerImage ?? null,
            genres: w.genres ?? [],
            playableNow: owners.length > 0,
            owners,
            cheapestPrice: w.cheapestPrice ?? null,
            cheapestStore: w.cheapestStore ?? null,
            cheapestCurrency: w.cheapestCurrency ?? null,
            steamPrice: w.steamPrice ?? null,
            steamInitialPrice: w.steamInitialPrice ?? null,
            steamDiscount: w.steamDiscount ?? null,
            steamCurrency: w.steamCurrency ?? null,
            reviewScore: w.reviewScore ?? null,
            reviewPositive: w.reviewPositive ?? null,
            reviewNegative: w.reviewNegative ?? null,
            releaseDate: w.releaseDate ?? null,
            playModes: w.playModes ?? [],
          };
        });
      }
    }

    return res.status(200).json({
      ok: true,
      authenticated: true,
      allowed,
      isAdmin: admin,
      // Pourquoi l'accès est accordé (ou refusé) : la page de connexion et la
      // page admin s'en servent pour expliquer la situation.
      accessSource: decision.source,
      accessReason: decision.reason,
      isMember: decision.membership.state === 'member',
      membershipCheckedAt: decision.membership.checkedAt,
      membershipCheck: decision.membership.configured
        ? decision.membership.error
          ? 'error'
          : 'ok'
        : 'disabled',
      membershipError: decision.membership.error,
      botConfigured: isBotConfigured(),
      guildInviteUrl: inviteUrl(),
      // Drapeaux d'affichage pilotés depuis l'admin (pages en chantier).
      features: {
        recommendations: await recommendationsEnabled(),
      },
      discord: {
        id: du.discordId,
        username: du.username,
        globalName: du.globalName,
        avatarUrl: du.avatarUrl,
      },
      steam,
      games,
      stats,
      wishlist,
    });
  } catch (err: any) {
    console.error('[me]', err);
    return res.status(500).json({ error: err.message });
  }
}


/**
 * Statistiques de profil.
 *
 * La répartition par genre est PONDÉRÉE PAR LE TEMPS DE JEU, pas par le
 * nombre de jeux : posséder 40 jeux de survie jamais lancés ne dit rien,
 * alors que 300 h dessus est un vrai signal.
 */
function buildStats(games: {
  playtime: number;
  genres: string[];
  name: string;
  source?: string;
}[]) {
  let totalMinutes = 0;
  let playedGames = 0;
  const genreMinutes = new Map<string, { minutes: number; games: number }>();

  for (const g of games) {
    const minutes = g.playtime || 0;
    totalMinutes += minutes;
    if (minutes > 0) playedGames++;

    for (const genre of g.genres) {
      const entry = genreMinutes.get(genre) ?? { minutes: 0, games: 0 };
      entry.minutes += minutes;
      entry.games += 1;
      genreMinutes.set(genre, entry);
    }
  }

  const topGenres = [...genreMinutes.entries()]
    .map(([name, v]) => ({ name, minutes: v.minutes, games: v.games }))
    .sort((a, b) => b.minutes - a.minutes || b.games - a.games)
    .slice(0, 8);

  // Répartition par origine : la carte « Ma ludothèque » doit dire combien de
  // jeux ne viennent pas du compte principal.
  const familyGames = games.filter((g) => g.source === 'family').length;
  const secondaryGames = games.filter((g) => g.source === 'secondary').length;
  const ownedGamesCount = games.length - familyGames - secondaryGames;

  return {
    totalGames: games.length,
    ownedGames: ownedGamesCount,
    familyGames,
    secondaryGames,
    sharedGames: familyGames + secondaryGames,
    playedGames,
    neverPlayed: games.length - playedGames,
    totalMinutes,
    averageMinutes: playedGames > 0 ? Math.round(totalMinutes / playedGames) : 0,
    enrichedGames: games.filter((g: any) => g.enriched).length,
    topGenres,
  };
}
