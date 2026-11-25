import { requireAccess } from '../access.ts';
import { getDb } from '../../db/index.ts';
import { notificationPrefs } from '../../db/schema.ts';
import { eq } from 'drizzle-orm';

/**
 * /api/notifications — préférences de notification du membre connecté.
 *
 * GET  : état courant
 * POST : { releaseReminders: boolean }
 *
 * Choix de conception : c'est le MEMBRE qui active le rappel, pas l'admin.
 * L'admin décide seulement du moment et du salon ; personne n'est notifié
 * sans l'avoir demandé.
 */
export default async function handler(req: any, res: any) {
  const ctx = await requireAccess(req, res);
  if (!ctx) return;

  const method = (req.method || 'GET').toUpperCase();

  try {
    const db = getDb();

    if (method === 'GET') {
      const [row] = await db
        .select()
        .from(notificationPrefs)
        .where(eq(notificationPrefs.discordId, ctx.discordId))
        .limit(1);

      return res.status(200).json({
        ok: true,
        releaseReminders: row?.releaseReminders ?? false,
      });
    }

    if (method === 'POST') {
      const body = (req.body ?? {}) as Record<string, unknown>;

      if (typeof body.releaseReminders !== 'boolean') {
        return res.status(400).json({ error: 'Valeur attendue : releaseReminders (booléen).' });
      }

      await db
        .insert(notificationPrefs)
        .values({
          discordId: ctx.discordId,
          releaseReminders: body.releaseReminders,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: notificationPrefs.discordId,
          set: { releaseReminders: body.releaseReminders, updatedAt: new Date() },
        });

      return res.status(200).json({ ok: true, releaseReminders: body.releaseReminders });
    }

    return res.status(405).json({ error: `Méthode ${method} non supportée.` });
  } catch (err: any) {
    console.error('[notifications]', err);
    return res.status(500).json({ error: err.message });
  }
}
