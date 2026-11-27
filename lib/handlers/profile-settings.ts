import { getDb } from '../../db/index.ts';
import { discordUsers } from '../../db/schema.ts';
import { eq } from 'drizzle-orm';
import { requireAccess } from '../access.ts';

/**
 * /api/profile-settings — ce que les AUTRES voient de moi.
 *
 * GET  : { gamesPublic, profilePublic }
 * POST : { gamesPublic?, profilePublic? }
 *
 * Deux interrupteurs, par personne, réglés depuis son propre profil :
 *   • `gamesPublic`   → nombre de jeux et temps de jeu visibles par les
 *                       visiteurs NON CONNECTÉS (annuaire + fiche) ;
 *   • `profilePublic` → la fiche est consultable sans compte Discord.
 *
 * Les membres connectés du site voient toujours tout : ces réglages protègent
 * de l'extérieur, pas du groupe. Défaut : false / false.
 */
export default async function handler(req: any, res: any) {
  const ctx = await requireAccess(req, res);
  if (!ctx) return;

  const db = getDb();
  const method = (req.method || 'GET').toUpperCase();

  try {
    if (method === 'GET') {
      const [row] = await db
        .select({
          gamesPublic: discordUsers.gamesPublic,
          profilePublic: discordUsers.profilePublic,
        })
        .from(discordUsers)
        .where(eq(discordUsers.discordId, ctx.discordId))
        .limit(1);

      return res.status(200).json({
        ok: true,
        gamesPublic: Boolean(row?.gamesPublic),
        profilePublic: Boolean(row?.profilePublic),
      });
    }

    if (method !== 'POST') {
      return res.status(405).json({ error: `Méthode ${method} non supportée.` });
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: { gamesPublic?: boolean; profilePublic?: boolean } = {};

    if (typeof body.gamesPublic === 'boolean') patch.gamesPublic = body.gamesPublic;
    if (typeof body.profilePublic === 'boolean') patch.profilePublic = body.profilePublic;

    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'Aucun réglage à modifier.' });
    }

    await db
      .update(discordUsers)
      .set(patch)
      .where(eq(discordUsers.discordId, ctx.discordId));

    const [row] = await db
      .select({
        gamesPublic: discordUsers.gamesPublic,
        profilePublic: discordUsers.profilePublic,
      })
      .from(discordUsers)
      .where(eq(discordUsers.discordId, ctx.discordId))
      .limit(1);

    return res.status(200).json({
      ok: true,
      gamesPublic: Boolean(row?.gamesPublic),
      profilePublic: Boolean(row?.profilePublic),
    });
  } catch (err: any) {
    console.error('[profile-settings]', err);
    return res.status(500).json({ error: err.message });
  }
}
