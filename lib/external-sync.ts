import { getDb } from '../db/index.ts';
import { externalAccounts, externalGames } from '../db/schema.ts';
import { and, eq, inArray, lt, or, sql } from 'drizzle-orm';
import { open, seal } from './crypto.ts';
import {
  exchangeGogCode,
  getGogLibrary,
  getGogUser,
  refreshGogTokens,
  type GogTokens,
} from './gog.ts';
import {
  exchangeEpicCode,
  getEpicAssets,
  getEpicCatalog,
  getEpicLibrary,
  getEpicPlaytime,
  refreshEpicTokens,
  type EpicTokens,
} from './epic.ts';

/**
 * Liaison et synchronisation des comptes GOG / Epic.
 *
 * Les jetons arrivent chiffrés en base ; on ne les déchiffre qu'ici, le temps
 * d'un appel, et on ne les renvoie JAMAIS au navigateur.
 *
 * Les deux plateformes n'offrent pas la même chose :
 *   - GOG  : ludothèque (titre, jaquette). Pas de temps de jeu.
 *   - Epic : ludothèque + temps de jeu total par jeu (en secondes).
 */

export type Platform = 'gog' | 'epic';


export interface ExternalAccountRow {
  id: string;
  discordId: string;
  platform: string;
  accountId: string;
  displayName: string | null;
  avatarUrl: string | null;
  profileUrl: string | null;
  accessTokenEnc: string | null;
  refreshTokenEnc: string | null;
  tokenExpiresAt: Date | null;
  gamesCount: number;
  lastSyncedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
}

function rowId(discordId: string, platform: Platform, accountId: string): string {
  return `${discordId}:${platform}:${accountId}`;
}


async function storeTokens(
  id: string,
  tokens: { accessToken: string; refreshToken: string; expiresAt: Date },
): Promise<void> {
  const db = getDb();
  await db
    .update(externalAccounts)
    .set({
      accessTokenEnc: seal(tokens.accessToken),
      refreshTokenEnc: tokens.refreshToken ? seal(tokens.refreshToken) : null,
      tokenExpiresAt: tokens.expiresAt,
    })
    .where(eq(externalAccounts.id, id));
}

/* ─────────────────────────── Liaison ─────────────────────────── */

export async function linkGogAccount(discordId: string, code: string): Promise<ExternalAccountRow> {
  const tokens: GogTokens = await exchangeGogCode(code);
  // Le profil sert d'identité : on refuse un code qui ne donne rien.
  const user = await getGogUser(tokens.accessToken);
  const id = rowId(discordId, 'gog', user.userId);

  const db = getDb();
  await db
    .insert(externalAccounts)
    .values({
      id,
      discordId,
      platform: 'gog',
      accountId: user.userId,
      displayName: user.username,
      avatarUrl: user.avatarUrl,
      profileUrl: `https://www.gog.com/u/${user.username}`,
      accessTokenEnc: seal(tokens.accessToken),
      refreshTokenEnc: seal(tokens.refreshToken),
      tokenExpiresAt: tokens.expiresAt,
    })
    .onConflictDoUpdate({
      target: externalAccounts.id,
      set: {
        displayName: user.username,
        avatarUrl: user.avatarUrl,
        accessTokenEnc: seal(tokens.accessToken),
        refreshTokenEnc: seal(tokens.refreshToken),
        tokenExpiresAt: tokens.expiresAt,
        lastError: null,
      },
    });

  return syncExternalAccount(id);
}

export async function linkEpicAccount(discordId: string, code: string): Promise<ExternalAccountRow> {
  const tokens: EpicTokens = await exchangeEpicCode(code);
  if (!tokens.accountId) throw new Error('Epic n’a pas renvoyé d’identifiant de compte.');

  const id = rowId(discordId, 'epic', tokens.accountId);
  const db = getDb();

  await db
    .insert(externalAccounts)
    .values({
      id,
      discordId,
      platform: 'epic',
      accountId: tokens.accountId,
      displayName: tokens.displayName || `Compte Epic ${tokens.accountId.slice(-6)}`,
      profileUrl: `https://store.epicgames.com/u/${tokens.accountId}`,
      accessTokenEnc: seal(tokens.accessToken),
      refreshTokenEnc: seal(tokens.refreshToken || ''),
      tokenExpiresAt: tokens.expiresAt,
    })
    .onConflictDoUpdate({
      target: externalAccounts.id,
      set: {
        displayName: tokens.displayName || null,
        accessTokenEnc: seal(tokens.accessToken),
        refreshTokenEnc: seal(tokens.refreshToken || ''),
        tokenExpiresAt: tokens.expiresAt,
        lastError: null,
      },
    });

  return syncExternalAccount(id);
}

/* ─────────────────────── Jetons d'accès ─────────────────────── */

/**
 * Renvoie un access token valide, en le rafraîchissant si besoin.
 *
 * ATTENTION Epic : le refresh token change à chaque rafraîchissement. On le
 * réécrit immédiatement en base ; un échec de cette écriture rendrait le
 * compte inutilisable (il faudrait le relier à nouveau).
 */
async function ensureAccessToken(row: ExternalAccountRow): Promise<string> {
  const expires = row.tokenExpiresAt?.getTime() ?? 0;
  // Marge de 2 minutes : évite d'envoyer un jeton qui expire en vol.
  if (expires > Date.now() + 120_000) {
    const token = open(row.accessTokenEnc);
    if (token) return token;
  }

  const refreshToken = open(row.refreshTokenEnc);
  if (!refreshToken) {
    throw new Error('Session expirée : relie le compte à nouveau.');
  }

  const tokens =
    row.platform === 'gog'
      ? await refreshGogTokens(refreshToken)
      : await refreshEpicTokens(refreshToken);

  await storeTokens(row.id, tokens);
  return tokens.accessToken;
}

/* ────────────────────────── Synchronisation ────────────────────────── */

export async function syncExternalAccount(accountRowId: string): Promise<ExternalAccountRow> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(externalAccounts)
    .where(eq(externalAccounts.id, accountRowId))
    .limit(1);

  if (!row) throw new Error('Compte introuvable.');

  try {
    const accessToken = await ensureAccessToken(row as ExternalAccountRow);

    /**
     * Le profil (pseudo, avatar) est rafraîchi à chaque sync : il change côté
     * plateforme, et l'avatar GOG n'est correct que s'il est récupéré ici —
     * à la liaison, le compte peut n'avoir aucune image.
     */
    if (row.platform === 'gog') {
      try {
        const user = await getGogUser(accessToken);
        await db
          .update(externalAccounts)
          .set({
            displayName: user.username,
            avatarUrl: user.avatarUrl,
            profileUrl: `https://www.gog.com/u/${user.username}`,
          })
          .where(eq(externalAccounts.id, row.id));
      } catch {
        /* profil indisponible : la ludothèque reste synchronisable */
      }
    }

    const games =
      row.platform === 'gog'
        ? await syncGog(accessToken)
        : await syncEpic(accessToken, row.accountId);

    // Remplacement complet : une ludothèque ne s'ajoute pas, elle se remplace
    // (un jeu retiré du compte doit disparaître).
    await db.delete(externalGames).where(eq(externalGames.accountRowId, row.id));

    for (let i = 0; i < games.length; i += 200) {
      const slice = games.slice(i, i + 200);
      if (slice.length === 0) continue;
      await db.insert(externalGames).values(
        slice.map((g) => ({
          accountRowId: row.id,
          externalId: g.id,
          name: g.name,
          imageUrl: g.imageUrl,
          minutes: g.minutes,
          updatedAt: new Date(),
        })),
      );
    }

    await db
      .update(externalAccounts)
      .set({
        gamesCount: games.length,
        lastSyncedAt: new Date(),
        lastError: null,
      })
      .where(eq(externalAccounts.id, row.id));

    const [updated] = await db
      .select()
      .from(externalAccounts)
      .where(eq(externalAccounts.id, row.id))
      .limit(1);
    return updated as ExternalAccountRow;
  } catch (err: any) {
    const message = String(err?.message ?? 'Synchronisation impossible').slice(0, 300);
    await db
      .update(externalAccounts)
      .set({ lastError: message, lastSyncedAt: new Date() })
      .where(eq(externalAccounts.id, row.id));

    const [updated] = await db
      .select()
      .from(externalAccounts)
      .where(eq(externalAccounts.id, row.id))
      .limit(1);
    return updated as ExternalAccountRow;
  }
}

interface SyncedGame {
  id: string;
  name: string;
  imageUrl: string | null;
  minutes: number;
}

async function syncGog(accessToken: string): Promise<SyncedGame[]> {
  const library = await getGogLibrary(accessToken);
  // GOG ne publie pas de temps de jeu : on ne peut pas le deviner.
  return library.map((g) => ({
    id: g.id,
    name: g.name,
    imageUrl: g.imageUrl,
    minutes: 0,
  }));
}

async function syncEpic(accessToken: string, accountId: string): Promise<SyncedGame[]> {
  // Les assets sont la vraie liste des jeux installables. Si l'endpoint ne
  // répond pas, on retombe sur les droits du compte (moins précis, mais
  // jamais vide).
  const assets = await getEpicAssets(accessToken);
  const library = assets.length > 0 ? assets : await getEpicLibrary(accessToken);

  const [playtime, catalog] = await Promise.all([
    getEpicPlaytime(accessToken, accountId),
    getEpicCatalog(accessToken, library),
  ]);

  const seen = new Set<string>();
  const games: SyncedGame[] = [];

  for (const entry of library) {
    // Deux sandboxes du même jeu partagent l'appName : on ne le compte qu'une fois.
    if (seen.has(entry.appName)) continue;
    seen.add(entry.appName);

    const meta = catalog.get(entry.catalogItemId);
    // DLC et add-ons ne sont pas des jeux à part entière.
    if (meta?.isAddon) continue;

    const seconds = playtime.get(entry.appName) ?? 0;

    games.push({
      id: entry.appName,
      name: meta?.name ?? entry.appName,
      imageUrl: meta?.imageUrl ?? null,
      minutes: Math.round(seconds / 60),
    });
  }

  return games;
}

/** Compte les jeux et le temps de jeu par plateforme, pour l'affichage. */
export async function getExternalSummary(discordId: string): Promise<{
  accounts: {
    id: string;
    platform: Platform;
    displayName: string | null;
    avatarUrl: string | null;
    profileUrl: string | null;
    gamesCount: number;
    minutes: number;
    lastSyncedAt: Date | null;
    lastError: string | null;
  }[];
}> {
  const db = getDb();
  const rows = await db
    .select()
    .from(externalAccounts)
    .where(eq(externalAccounts.discordId, discordId));

  const ids = rows.map((r) => r.id);
  const totals = ids.length
    ? await db
        .select({
          accountRowId: externalGames.accountRowId,
          minutes: sql<number>`coalesce(sum(${externalGames.minutes}), 0)::int`,
          games: sql<number>`count(*)::int`,
        })
        .from(externalGames)
        .where(inArray(externalGames.accountRowId, ids))
        .groupBy(externalGames.accountRowId)
    : [];

  const byId = new Map(totals.map((t) => [t.accountRowId, t]));

  return {
    accounts: rows.map((r) => ({
      id: r.id,
      platform: r.platform as Platform,
      displayName: r.displayName,
      avatarUrl: r.avatarUrl,
      profileUrl: r.profileUrl,
      gamesCount: Number(byId.get(r.id)?.games ?? r.gamesCount),
      minutes: Number(byId.get(r.id)?.minutes ?? 0),
      lastSyncedAt: r.lastSyncedAt,
      lastError: r.lastError,
    })),
  };
}

/** Les jeux d'un compte, pour la liste dépliée du profil. */
export async function getExternalGames(accountRowId: string, limit = 60) {
  const db = getDb();
  return db
    .select({
      externalId: externalGames.externalId,
      name: externalGames.name,
      imageUrl: externalGames.imageUrl,
      minutes: externalGames.minutes,
    })
    .from(externalGames)
    .where(eq(externalGames.accountRowId, accountRowId))
    .orderBy(sql`${externalGames.minutes} DESC, ${externalGames.name} ASC`)
    .limit(limit);
}

/**
 * Tous les jeux GOG/Epic d'un membre, tous comptes confondus.
 *
 * Sert à la ludothèque : les jeux externes y apparaissent sous leur
 * plateforme, sans être mélangés aux totaux Steam.
 */
export async function getAllExternalGames(discordId: string): Promise<
  {
    accountId: string;
    platform: Platform;
    displayName: string | null;
    externalId: string;
    name: string;
    imageUrl: string | null;
    minutes: number;
  }[]
> {
  const db = getDb();
  const accounts = await db
    .select({
      id: externalAccounts.id,
      platform: externalAccounts.platform,
      displayName: externalAccounts.displayName,
    })
    .from(externalAccounts)
    .where(eq(externalAccounts.discordId, discordId));

  if (accounts.length === 0) return [];

  const byId = new Map(accounts.map((a) => [a.id, a]));
  const rows = await db
    .select()
    .from(externalGames)
    .where(inArray(externalGames.accountRowId, accounts.map((a) => a.id)));

  return rows.map((r) => {
    const account = byId.get(r.accountRowId)!;
    return {
      accountId: account.id,
      platform: account.platform as Platform,
      displayName: account.displayName,
      externalId: r.externalId,
      name: r.name,
      imageUrl: r.imageUrl,
      minutes: r.minutes,
    };
  });
}

/** Détache un compte et ses jeux. */
export async function unlinkExternalAccount(discordId: string, id: string): Promise<boolean> {
  const db = getDb();
  const [row] = await db
    .select({ id: externalAccounts.id })
    .from(externalAccounts)
    .where(and(eq(externalAccounts.id, id), eq(externalAccounts.discordId, discordId)))
    .limit(1);
  if (!row) return false;

  await db.delete(externalGames).where(eq(externalGames.accountRowId, id));
  await db.delete(externalAccounts).where(eq(externalAccounts.id, id));
  return true;
}

/**
 * Rafraîchit les comptes les plus anciens, dans un budget de temps.
 *
 * Appelée par la tâche horaire : on étale pour ne jamais dépasser le délai
 * d'exécution d'une fonction Netlify.
 */
export async function syncDueExternalAccounts(budgetMs = 8_000): Promise<{
  handled: number;
  failed: number;
  remaining: number;
}> {
  const db = getDb();
  const started = Date.now();
  const cutoff = new Date(Date.now() - 24 * 3_600_000);

  const rows = await db
    .select()
    .from(externalAccounts)
    .where(
      or(
        lt(externalAccounts.lastSyncedAt, cutoff),
        sql`${externalAccounts.lastSyncedAt} IS NULL`,
      ),
    )
    .orderBy(sql`${externalAccounts.lastSyncedAt} ASC NULLS FIRST`)
    .limit(20);

  let handled = 0;
  let failed = 0;
  let remaining = 0;

  for (const row of rows) {
    if (Date.now() - started > budgetMs) {
      remaining += 1;
      continue;
    }
    const result = await syncExternalAccount(row.id);
    handled += 1;
    if (result.lastError) failed += 1;
  }

  return { handled, failed, remaining };
}
