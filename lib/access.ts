import { getDb } from '../db/index.ts';
import { discordUsers, allowedDiscordIds, steamLinks, users } from '../db/schema.ts';
import { eq } from 'drizzle-orm';
import { COOKIE_NAME, parseCookies, readSession } from './session.ts';
import { isAdminId } from './discord.ts';
import { getGuildMember, isBotConfigured, inviteUrl } from './discord-bot.ts';
import type { DiscordProfile } from './discord.ts';

/**
 * Contrôle d'accès du site.
 *
 * RÈGLES
 * ------
 * Trois portes, dans cet ordre :
 *
 *   1. ADMIN          → DISCORD_ADMIN_ID (env). Toujours autorisé.
 *   2. MEMBRE DU SERVEUR → vérifié via le bot Discord à chaque connexion,
 *      puis remis à jour au plus toutes les 10 minutes (cache en base).
 *   3. LISTE BLANCHE   → exceptions gérées depuis la page admin, pour les
 *      personnes qui ne sont PAS sur le serveur Discord.
 *
 * Le reste est refusé.
 *
 * CAS PARTICULIER : si le bot n'est pas configuré (DISCORD_BOT_TOKEN /
 * DISCORD_GUILD_ID absents), l'étape 2 est neutralisée et on retombe sur
 * l'ancien comportement (admin + liste blanche). C'est volontaire : une
 * configuration incomplète ne doit pas enfermer tout le monde dehors.
 */

/** Durée de validité de la vérification d'appartenance en base. */
const MEMBERSHIP_TTL_MS = 10 * 60_000;

/** En cas d'échec Discord, on ne réessaie pas à chaque requête. */
const MEMBERSHIP_RETRY_MS = 60_000;

export type MembershipState = 'member' | 'not_member' | 'unknown';

export interface MembershipInfo {
  /** Le bot est-il configuré ? Sinon la vérification est désactivée. */
  configured: boolean;
  state: MembershipState;
  checkedAt: Date | null;
  /** Renseigné si la vérification a été tentée mais a échoué. */
  error: string | null;
  /** true si l'on garde l'ancien statut « membre » faute de pouvoir vérifier. */
  stale: boolean;
}

export interface AccessDecision {
  allowed: boolean;
  source: 'admin' | 'member' | 'whitelist' | null;
  /** Renseigné uniquement quand l'accès est refusé. */
  reason: 'NOT_MEMBER' | 'MEMBERSHIP_UNVERIFIED' | null;
  membership: MembershipInfo;
}

export interface AccessContext {
  discordId: string;
  username: string;
  globalName: string | null;
  avatarUrl: string | null;
  isAdmin: boolean;
  /** Membre du serveur Discord (dernière vérification connue). */
  isMember: boolean;
  accessSource: 'admin' | 'member' | 'whitelist';
  /** null tant que le compte Steam n'est pas relié. */
  steamid: string | null;
  personaName: string | null;
  profileVisible: boolean;
  gamesVisible: boolean;
  lastSyncAt: Date | null;
}

/** Upsert du compte Discord après un login réussi. */
export async function upsertDiscordUser(profile: DiscordProfile) {
  const db = getDb();
  const admin = isAdminId(profile.id);

  await db
    .insert(discordUsers)
    .values({
      discordId: profile.id,
      username: profile.username,
      globalName: profile.globalName,
      avatarUrl: profile.avatarUrl,
      isAdmin: admin,
      lastLoginAt: new Date(),
    })
    .onConflictDoUpdate({
      target: discordUsers.discordId,
      set: {
        username: profile.username,
        globalName: profile.globalName,
        avatarUrl: profile.avatarUrl,
        isAdmin: admin,
        lastLoginAt: new Date(),
      },
    });
}

/* ═══════════════════ Appartenance au serveur Discord ═══════════════════ */

/** Déduplique les vérifications simultanées d'un même compte. */
const inFlight = new Map<string, Promise<MembershipInfo>>();

/** Horodatage du dernier échec, pour ne pas marteler Discord. */
const lastFailure = new Map<string, number>();

/**
 * Vérifie (ou relit en cache) l'appartenance d'un compte au serveur.
 *
 * Ne rejette jamais : en cas de panne Discord, on renvoie un état `unknown`
 * que l'appelant doit traiter prudemment.
 */
export function refreshMembership(
  discordId: string,
  opts: { force?: boolean } = {},
): Promise<MembershipInfo> {
  const pending = inFlight.get(discordId);
  if (pending) return pending;

  const p = doRefreshMembership(discordId, opts).finally(() => inFlight.delete(discordId));
  inFlight.set(discordId, p);
  return p;
}

async function doRefreshMembership(
  discordId: string,
  opts: { force?: boolean },
): Promise<MembershipInfo> {
  const db = getDb();

  const [row] = await db
    .select({
      isMember: discordUsers.isMember,
      memberCheckedAt: discordUsers.memberCheckedAt,
    })
    .from(discordUsers)
    .where(eq(discordUsers.discordId, discordId))
    .limit(1);

  const checkedAt = row?.memberCheckedAt ?? null;
  const configured = isBotConfigured();

  if (!configured) {
    return {
      configured: false,
      state: 'unknown',
      checkedAt,
      error: null,
      stale: false,
    };
  }

  const age = checkedAt ? Date.now() - checkedAt.getTime() : Infinity;
  const fresh = age < MEMBERSHIP_TTL_MS;

  if (!opts.force && fresh) {
    return {
      configured: true,
      state: row?.isMember ? 'member' : 'not_member',
      checkedAt,
      error: null,
      stale: false,
    };
  }

  const failedAt = lastFailure.get(discordId);
  if (failedAt && Date.now() - failedAt < MEMBERSHIP_RETRY_MS) {
    return fallback(row?.isMember ?? false, checkedAt, 'Vérification temporairement indisponible.');
  }

  try {
    const member = await getGuildMember(discordId);
    const isMember = member !== null;
    const now = new Date();

    await db
      .update(discordUsers)
      .set({ isMember, memberCheckedAt: now })
      .where(eq(discordUsers.discordId, discordId));

    lastFailure.delete(discordId);

    return {
      configured: true,
      state: isMember ? 'member' : 'not_member',
      checkedAt: now,
      error: null,
      stale: false,
    };
  } catch (err: any) {
    lastFailure.set(discordId, Date.now());
    // Un admin verra ce message dans la page Admin : inutile de noyer les logs.
    console.warn('[membership]', discordId, err?.message);

    // Panne passagère : on conserve le dernier statut connu s'il était positif,
    // sinon on refuse sans affirmer « pas membre ».
    return fallback(row?.isMember ?? false, checkedAt, err?.message ?? 'Discord injoignable.');
  }
}

function fallback(isMember: boolean, checkedAt: Date | null, error: string): MembershipInfo {
  return {
    configured: true,
    state: isMember ? 'member' : 'unknown',
    checkedAt,
    error,
    stale: isMember,
  };
}

/* ═══════════════════════════ Décision d'accès ═══════════════════════════ */

/**
 * Décide de l'accès d'un compte, sans réponse HTTP.
 *
 * Utilisé par requireAccess() et par /api/me, pour que les deux ne puissent
 * pas diverger.
 */
export async function resolveAccess(
  discordId: string,
  opts: { forceMembership?: boolean } = {},
): Promise<AccessDecision> {
  const admin = isAdminId(discordId);
  const membership = await refreshMembership(discordId, {
    force: opts.forceMembership,
  });

  if (admin) {
    return { allowed: true, source: 'admin', reason: null, membership };
  }

  if (membership.state === 'member') {
    return { allowed: true, source: 'member', reason: null, membership };
  }

  // Exceptions gérées depuis la page admin.
  const db = getDb();
  const [row] = await db
    .select({ id: allowedDiscordIds.discordId })
    .from(allowedDiscordIds)
    .where(eq(allowedDiscordIds.discordId, discordId))
    .limit(1);

  if (row) {
    return { allowed: true, source: 'whitelist', reason: null, membership };
  }

  return {
    allowed: false,
    source: null,
    reason: membership.state === 'not_member' ? 'NOT_MEMBER' : 'MEMBERSHIP_UNVERIFIED',
    membership,
  };
}

/** Conservé pour les appelants qui n'ont besoin que d'un booléen. */
export async function isAllowed(discordId: string): Promise<boolean> {
  return (await resolveAccess(discordId)).allowed;
}

/* ═══════════════════════════ Résolution HTTP ═══════════════════════════ */

/**
 * Résout la session courante en contexte d'accès.
 * Répond lui-même en cas de refus et renvoie null.
 */
export async function requireAccess(
  req: { headers: Record<string, any> },
  res: any,
): Promise<AccessContext | null> {
  const cookies = parseCookies(req.headers?.cookie);
  const sess = await readSession(cookies[COOKIE_NAME]);

  if (!sess) {
    res.status(401).json({ error: 'Non connecté. Connecte-toi avec Discord.' });
    return null;
  }

  const db = getDb();
  const [du] = await db
    .select()
    .from(discordUsers)
    .where(eq(discordUsers.discordId, sess.discordId))
    .limit(1);

  // Session orpheline : le compte Discord a été supprimé.
  if (!du) {
    res.status(401).json({ error: 'Compte inconnu. Reconnecte-toi.' });
    return null;
  }

  const decision = await resolveAccess(du.discordId);

  if (!decision.allowed) {
    return deny(res, {
      discordId: du.discordId,
      username: du.username,
      reason: decision.reason,
      membership: decision.membership,
    });
  }

  // Liaison Steam éventuelle.
  let steamid: string | null = null;
  let personaName: string | null = null;
  let profileVisible = false;
  let gamesVisible = false;
  let lastSyncAt: Date | null = null;

  const [link] = await db
    .select({ steamid: steamLinks.steamid })
    .from(steamLinks)
    .where(eq(steamLinks.discordId, du.discordId))
    .limit(1);

  if (link?.steamid) {
    steamid = link.steamid;
    const [u] = await db.select().from(users).where(eq(users.steamid, steamid)).limit(1);
    if (u) {
      personaName = u.personaName;
      profileVisible = u.profileVisible;
      gamesVisible = u.gamesVisible;
      lastSyncAt = u.lastSyncAt;
    }
  }

  return {
    discordId: du.discordId,
    username: du.username,
    globalName: du.globalName,
    avatarUrl: du.avatarUrl,
    isAdmin: decision.source === 'admin',
    isMember: decision.membership.state === 'member',
    accessSource: decision.source ?? 'whitelist',
    steamid,
    personaName,
    profileVisible,
    gamesVisible,
    lastSyncAt,
  };
}

/**
 * Comme `requireAccess`, mais SANS refuser : renvoie null si le visiteur n'est
 * pas connecté ou n'a pas accès, sans écrire de réponse.
 *
 * Utilisé par les pages publiques (événements, Twitch) : un visiteur non
 * connecté voit le contenu, et un membre voit en plus ses propres actions.
 */
export async function optionalAccess(req: {
  headers: Record<string, any>;
}): Promise<AccessContext | null> {
  try {
    const cookies = parseCookies(req.headers?.cookie);
    const sess = await readSession(cookies[COOKIE_NAME]);
    if (!sess) return null;

    const db = getDb();
    const [du] = await db
      .select()
      .from(discordUsers)
      .where(eq(discordUsers.discordId, sess.discordId))
      .limit(1);
    if (!du) return null;

    const decision = await resolveAccess(du.discordId);
    if (!decision.allowed) return null;

    let steamid: string | null = null;
    let personaName: string | null = null;
    let profileVisible = false;
    let gamesVisible = false;
    let lastSyncAt: Date | null = null;

    const [link] = await db
      .select({ steamid: steamLinks.steamid })
      .from(steamLinks)
      .where(eq(steamLinks.discordId, du.discordId))
      .limit(1);

    if (link?.steamid) {
      steamid = link.steamid;
      const [u] = await db.select().from(users).where(eq(users.steamid, steamid)).limit(1);
      if (u) {
        personaName = u.personaName;
        profileVisible = u.profileVisible;
        gamesVisible = u.gamesVisible;
        lastSyncAt = u.lastSyncAt;
      }
    }

    return {
      discordId: du.discordId,
      username: du.username,
      globalName: du.globalName,
      avatarUrl: du.avatarUrl,
      isAdmin: decision.source === 'admin',
      isMember: decision.membership.state === 'member',
      accessSource: decision.source ?? 'whitelist',
      steamid,
      personaName,
      profileVisible,
      gamesVisible,
      lastSyncAt,
    };
  } catch (err: any) {
    console.warn('[access] session illisible :', err?.message);
    return null;
  }
}

/** Réponse 403 homogène, avec la marche à suivre. */
export function deny(
  res: any,
  args: {
    discordId: string;
    username?: string;
    reason: AccessDecision['reason'];
    membership?: MembershipInfo;
  },
) {
  const notMember = args.reason === 'NOT_MEMBER';
  const invite = inviteUrl();

  const message = notMember
    ? 'Accès refusé : ton compte Discord n’est pas membre du serveur. ' +
      'Rejoins le serveur Discord puis reconnecte-toi, ou demande à un ' +
      'administrateur de t’autoriser manuellement.'
    : 'Accès refusé : impossible de vérifier que tu es membre du serveur Discord ' +
      '(bot non configuré ou Discord injoignable). Demande à un administrateur ' +
      'de t’autoriser manuellement.';

  return res.status(403).json({
    error: message,
    code: args.reason ?? 'NOT_ALLOWED',
    discordId: args.discordId,
    username: args.username ?? null,
    inviteUrl: invite,
    membershipCheck: args.membership?.configured
      ? args.membership.error
        ? 'error'
        : 'ok'
      : 'disabled',
    membershipError: args.membership?.error ?? null,
  });
}

/** Variante exigeant en plus un compte Steam relié. */
export async function requireSteam(
  req: { headers: Record<string, any> },
  res: any,
): Promise<(AccessContext & { steamid: string }) | null> {
  const ctx = await requireAccess(req, res);
  if (!ctx) return null;

  if (!ctx.steamid) {
    res.status(400).json({
      error:
        'Aucun compte Steam relié. Commence par relier ton compte Steam depuis la page d’accueil.',
      code: 'NO_STEAM_LINK',
    });
    return null;
  }
  return ctx as AccessContext & { steamid: string };
}

/** Variante réservée à l'admin. */
export async function requireAdmin(
  req: { headers: Record<string, any> },
  res: any,
): Promise<AccessContext | null> {
  const ctx = await requireAccess(req, res);
  if (!ctx) return null;

  if (!ctx.isAdmin) {
    res.status(403).json({ error: 'Réservé à l’administrateur.', code: 'NOT_ADMIN' });
    return null;
  }
  return ctx;
}
