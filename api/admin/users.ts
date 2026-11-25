import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb } from '../../db/index.ts';
import { discordUsers, allowedDiscordIds, steamLinks, users } from '../../db/schema.ts';
import { desc, eq, sql } from 'drizzle-orm';
import { requireAdmin } from '../../lib/access.ts';
import { adminIds } from '../../lib/discord.ts';

/**
 * /api/admin/users — gestion de la whitelist Discord.
 *
 *   GET    → liste des IDs autorisés + tous les comptes déjà vus
 *   POST   → ajoute un ou plusieurs discord_id (body { discordIds: string[] })
 *   DELETE → retire un discord_id (query ?id=...)
 *
 * Toutes les méthodes passent par requireAdmin : l'admin est défini par
 * DISCORD_ADMIN_ID dans l'environnement et n'est pas supprimable via l'UI.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  try {
    if (req.method === 'GET') return list(req, res);
    if (req.method === 'POST') return add(req, res, admin.discordId);
    if (req.method === 'DELETE') return remove(req, res);

    return res.status(405).json({ error: `Méthode ${req.method} non supportée.` });
  } catch (err: any) {
    console.error('[admin/users]', err);
    return res.status(500).json({ error: err.message });
  }
}

async function list(req: VercelRequest, res: VercelResponse) {
  const db = getDb();

  const allowed = await db
    .select()
    .from(allowedDiscordIds)
    .orderBy(desc(allowedDiscordIds.createdAt));

  // Tous les comptes Discord qui se sont déjà connectés, avec leur statut.
  const known = await db
    .select({
      discordId: discordUsers.discordId,
      username: discordUsers.username,
      globalName: discordUsers.globalName,
      avatarUrl: discordUsers.avatarUrl,
      lastLoginAt: discordUsers.lastLoginAt,
      isAllowed: sql<boolean>`exists (
        select 1 from ${allowedDiscordIds}
        where ${allowedDiscordIds.discordId} = ${discordUsers.discordId}
      )`,
      hasSteam: sql<boolean>`exists (
        select 1 from ${steamLinks}
        where ${steamLinks.discordId} = ${discordUsers.discordId}
      )`,
    })
    .from(discordUsers)
    .orderBy(desc(discordUsers.lastLoginAt));

  // Persona Steam pour ceux qui ont relié leur compte.
  const links = await db
    .select({
      discordId: steamLinks.discordId,
      steamid: steamLinks.steamid,
      personaName: users.personaName,
    })
    .from(steamLinks)
    .leftJoin(users, eq(users.steamid, steamLinks.steamid));

  const steamByDiscord = new Map(
    links.map((l) => [l.discordId, { steamid: l.steamid, personaName: l.personaName }]),
  );

  return res.status(200).json({
    ok: true,
    admins: adminIds(),
    allowed,
    known: known.map((k) => ({
      ...k,
      isAdmin: adminIds().includes(k.discordId),
      steam: steamByDiscord.get(k.discordId) ?? null,
    })),
  });
}

async function add(req: VercelRequest, res: VercelResponse, addedBy: string) {
  const body = (req.body ?? {}) as { discordIds?: unknown; note?: string };

  // Accepte un tableau ou une chaîne multi-lignes / séparée par des virgules.
  let raw: string[] = [];
  if (Array.isArray(body.discordIds)) {
    raw = body.discordIds.map(String);
  } else if (typeof body.discordIds === 'string') {
    raw = String(body.discordIds).split(/[\s,;]+/);
  }

  const ids = raw.map((s) => s.trim()).filter(Boolean);

  if (ids.length === 0) {
    return res.status(400).json({ error: 'Aucun identifiant Discord fourni.' });
  }

  // Un snowflake Discord est un entier de 17 à 20 chiffres.
  const invalid = ids.filter((id) => !/^\d{17,20}$/.test(id));
  if (invalid.length > 0) {
    return res.status(400).json({
      error:
        'Identifiant(s) Discord invalide(s) : ' +
        invalid.join(', ') +
        '. Un ID Discord est une suite de 17 à 20 chiffres (clic droit sur le pseudo → Copier l’identifiant).',
    });
  }

  const db = getDb();
  await db
    .insert(allowedDiscordIds)
    .values(
      ids.map((discordId) => ({
        discordId,
        note: body.note ?? null,
        addedBy,
      })),
    )
    .onConflictDoNothing();

  return res.status(200).json({ ok: true, added: ids, count: ids.length });
}

async function remove(req: VercelRequest, res: VercelResponse) {
  const id = typeof req.query.id === 'string' ? req.query.id : '';
  if (!id) return res.status(400).json({ error: 'Paramètre id manquant.' });

  if (adminIds().includes(id)) {
    return res.status(400).json({
      error:
        'Cet identifiant est l’administrateur défini dans l’environnement : ' +
        'il ne peut pas être retiré depuis l’interface. Modifie DISCORD_ADMIN_ID.',
    });
  }

  const db = getDb();
  await db.delete(allowedDiscordIds).where(eq(allowedDiscordIds.discordId, id));

  return res.status(200).json({ ok: true, removed: id });
}
