import { getDb } from '../../db/index.ts';
import { discordEvents } from '../../db/schema.ts';
import { eq } from 'drizzle-orm';
import { requireAccess } from '../access.ts';
import { syncDescription, setInterest } from '../event-interest.ts';

/**
 * POST /api/events/interest — « Intéressé » / « Peut-être » depuis le site.
 *
 * Corps : { eventId, kind: 'interested' | 'maybe', active: boolean }
 *
 * DISCORD N'AUTORISE PAS un bot à cocher « Intéressé » à la place d'un membre.
 * On enregistre donc les clics côté site, puis on recopie les listes dans la
 * description de l'événement Discord : tout le serveur les voit, y compris
 * ceux qui ne passent jamais par le site.
 *
 * CONCURRENCE : deux personnes qui cliquent en même temps ne s'écrasent pas —
 * l'ajout est une requête SQL unique (verrou de ligne), et la description est
 * reconstruite à partir de l'état complet relu juste après.
 */
export default async function handler(req: any, res: any) {
  const ctx = await requireAccess(req, res);
  if (!ctx) return;

  if ((req.method || 'GET').toUpperCase() !== 'POST') {
    return res.status(405).json({ error: `Méthode ${req.method} non supportée.` });
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const eventId = String(body.eventId ?? '').trim();
  const kind = body.kind === 'maybe' ? 'maybe' : body.kind === 'interested' ? 'interested' : null;
  const active = Boolean(body.active);

  if (!/^\d{17,20}$/.test(eventId)) {
    return res.status(400).json({ error: 'Événement invalide.' });
  }
  if (!kind) {
    return res.status(400).json({ error: 'Type d’inscription inconnu.' });
  }

  try {
    const db = getDb();
    const [event] = await db
      .select({ id: discordEvents.id, name: discordEvents.name })
      .from(discordEvents)
      .where(eq(discordEvents.id, eventId))
      .limit(1);

    if (!event) {
      return res.status(404).json({ error: 'Cet événement n’existe plus.' });
    }

    const user = {
      id: ctx.discordId,
      name: ctx.globalName || ctx.username || 'Membre',
      avatarUrl: ctx.avatarUrl ?? null,
    };

    const lists = await setInterest(eventId, kind, user, active);
    if (!lists) {
      return res.status(404).json({ error: 'Cet événement n’existe plus.' });
    }

    // La description Discord suit, sans bloquer la réponse en cas d'échec :
    // l'inscription est enregistrée côté site quoi qu'il arrive.
    const warning = await syncDescription(eventId).then(
      () => null,
      (err: any) => {
        console.warn('[events/interest] description Discord non mise à jour :', err?.message);
        return 'La description Discord n’a pas pu être mise à jour (droits du bot ?).';
      },
    );

    return res.status(200).json({
      ok: true,
      interested: lists.interested,
      maybe: lists.maybe,
      warning,
    });
  } catch (err: any) {
    console.error('[events/interest]', err);
    return res.status(500).json({ error: err.message });
  }
}
