import { getDb } from '../db/index.ts';
import { discordUsers, allowedDiscordIds, steamLinks, users } from '../db/schema.ts';
import { eq } from 'drizzle-orm';
import { COOKIE_NAME, parseCookies, readSession } from './session.ts';
import { isAdminId } from './discord.ts';
import type { DiscordProfile } from './discord.ts';

/**
 * Contrôle d'accès du site.
 *
 * RÈGLES
 * ------
 * - Sans session Discord valide          → 401
 * - Connecté mais pas dans la whitelist  → 403 (sauf admin défini dans l'env)
 * - Admin                                → accès total, y compris page admin
 *
 * L'admin est défini par DISCORD_ADMIN_ID (dans l'env), pas en base : il ne
 * peut donc pas se retirer lui-même l'accès par erreur depuis l'UI.
 */

export interface AccessContext {
  discordId: string;
  username: string;
  globalName: string | null;
  avatarUrl: string | null;
  isAdmin: boolean;
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

/**
 * Vérifie si un discord_id est autorisé à utiliser le site.
 * L'admin est toujours autorisé, même absent de la table.
 */
export async function isAllowed(discordId: string) {
  if (isAdminId(discordId)) return true;
  const db = getDb();
  const [row] = await db
    .select({ id: allowedDiscordIds.discordId })
    .from(allowedDiscordIds)
    .where(eq(allowedDiscordIds.discordId, discordId))
    .limit(1);
  return Boolean(row);
}

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

  const admin = isAdminId(du.discordId);

  if (!admin && !(await isAllowed(du.discordId))) {
    res.status(403).json({
      error:
        'Accès refusé. Ton compte Discord n’est pas autorisé sur ce site. ' +
        'Demande à l’administrateur de t’ajouter.',
      code: 'NOT_ALLOWED',
      discordId: du.discordId,
      username: du.username,
    });
    return null;
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
    isAdmin: admin,
    steamid,
    personaName,
    profileVisible,
    gamesVisible,
    lastSyncAt,
  };
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
