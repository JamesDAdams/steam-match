import { requireAdmin } from '../access.ts';
import {
  createScheduledEvent,
  isBotConfigured,
  listEventChannels,
} from '../discord-bot.ts';
import { storeEvent } from '../events-sync.ts';
import { gameBannerDataUri } from '../game-banner.ts';

/**
 * POST /api/events/create — crée un événement programmé sur le serveur Discord.
 *
 * Réservé à l'administrateur : créer un rendez-vous engage tout le serveur,
 * c'est une action de modération, pas une action de membre.
 *
 * Le formulaire du site envoie :
 *   { name, description?, startAt, endAt?, entityType, channelId?, location? }
 *
 * On valide d'abord côté serveur : les messages de Discord sont en anglais et
 * peu parlants (« Invalid Form Body »), alors qu'on peut dire précisément ce
 * qui cloche en français.
 */
export default async function handler(req: any, res: any) {
  if ((req.method || 'GET').toUpperCase() !== 'POST') {
    return res.status(405).json({ error: `Méthode ${req.method} non supportée.` });
  }

  const ctx = await requireAdmin(req, res);
  if (!ctx) return;

  if (!isBotConfigured()) {
    return res.status(503).json({
      error:
        'Impossible de créer un événement : le bot Discord n’est pas configuré. ' +
        'Renseigne DISCORD_BOT_TOKEN et DISCORD_GUILD_ID, puis redéploie.',
      code: 'BOT_NOT_CONFIGURED',
    });
  }

  const body = (req.body ?? {}) as Record<string, unknown>;

  // ── Nom ──────────────────────────────────────────────────────────────
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name.length < 2) {
    return res.status(400).json({ error: 'Donne un nom à l’événement (2 caractères minimum).' });
  }
  if (name.length > 100) {
    return res.status(400).json({ error: 'Le nom ne peut pas dépasser 100 caractères.' });
  }

  // ── Description ──────────────────────────────────────────────────────
  const description =
    typeof body.description === 'string' ? body.description.trim() : '';
  if (description.length > 1000) {
    return res.status(400).json({ error: 'La description ne peut pas dépasser 1000 caractères.' });
  }

  // ── Bannière (data URI) ──────────────────────────────────────────────
  // Discord n'accepte pas un upload multipart : l'image doit arriver en
  // data URI base64 dans le JSON. Le navigateur la redimensionne déjà en
  // 1280×720 JPEG avant l'envoi ; on vérifie quand même ici, parce qu'un
  // appel direct à l'API ne passe pas par le formulaire.
  let image: string | null = null;
  if (typeof body.image === 'string' && body.image.trim() !== '') {
    const match = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/.exec(
      body.image.trim(),
    );
    if (!match) {
      return res.status(400).json({
        error: 'Bannière invalide : utilise une image PNG, JPEG ou WebP.',
      });
    }

    const bytes = Math.floor((match[2].length * 3) / 4);
    if (bytes > 2_000_000) {
      return res.status(400).json({
        error: 'Bannière trop lourde (2 Mo maximum après compression).',
      });
    }

    image = body.image.trim();
  } else if (body.image != null && body.image !== '') {
    return res.status(400).json({ error: 'Bannière invalide.' });
  }

  // ── Bannière issue du jeu choisi ─────────────────────────────────────
  // Le formulaire peut référencer un jeu de la bibliothèque : on récupère sa
  // jaquette Steam et on l'encode ici. Le navigateur en serait incapable
  // (canvas « tainted » sur une image d'un autre domaine).
  const gameAppid = Number(body.gameAppid);
  if (image === null && Number.isInteger(gameAppid) && gameAppid > 0) {
    image = await gameBannerDataUri(gameAppid).catch(() => null);
  }

  // ── Dates ────────────────────────────────────────────────────────────
  const startAt = new Date(String(body.startAt ?? ''));
  if (Number.isNaN(startAt.getTime())) {
    return res.status(400).json({ error: 'Date de début invalide.' });
  }

  const now = Date.now();
  if (startAt.getTime() < now + 60_000) {
    return res
      .status(400)
      .json({ error: 'La date de début doit être dans le futur (au moins une minute).' });
  }
  if (startAt.getTime() > now + 365 * 24 * 3_600_000) {
    return res.status(400).json({ error: 'La date de début doit être dans moins d’un an.' });
  }

  let endAt: Date | null = null;
  if (body.endAt != null && body.endAt !== '') {
    endAt = new Date(String(body.endAt));
    if (Number.isNaN(endAt.getTime())) {
      return res.status(400).json({ error: 'Date de fin invalide.' });
    }
    if (endAt.getTime() <= startAt.getTime()) {
      return res.status(400).json({ error: 'La fin doit être après le début.' });
    }
  }

  // ── Type : vocal ou externe ──────────────────────────────────────────
  const entityType = Number(body.entityType);
  if (entityType !== 2 && entityType !== 3) {
    return res
      .status(400)
      .json({ error: 'Type d’événement inconnu : choisis « vocal » ou « lieu externe ».' });
  }

  let channelId: string | null = null;
  let location: string | null = null;

  if (entityType === 2) {
    channelId = typeof body.channelId === 'string' ? body.channelId.trim() : '';
    if (!/^\d{17,20}$/.test(channelId)) {
      return res.status(400).json({ error: 'Choisis un salon vocal pour l’événement.' });
    }

    // Vérification souple : si la liste des salons est indisponible, on laisse
    // Discord trancher plutôt que d'inventer un refus.
    try {
      const channels = await listEventChannels();
      if (channels.length > 0 && !channels.some((c) => c.id === channelId)) {
        return res.status(400).json({
          error:
            'Ce salon vocal n’existe plus sur le serveur. Recharge la page et choisis-en un autre.',
        });
      }
    } catch {
      /* liste indisponible : Discord validera */
    }
  } else {
    location = typeof body.location === 'string' ? body.location.trim() : '';
    if (location.length < 2) {
      return res.status(400).json({ error: 'Indique un lieu ou un lien pour l’événement.' });
    }
    if (location.length > 100) {
      return res.status(400).json({ error: 'Le lieu ne peut pas dépasser 100 caractères.' });
    }
  }

  try {
    const created = await createScheduledEvent({
      name,
      description: description || null,
      startAt,
      endAt,
      entityType,
      channelId,
      location,
      image,
    });

    // On recopie immédiatement en base pour que la page se rafraîchisse sans
    // attendre le prochain clic sur « Synchroniser ». Un échec ici ne remet
    // pas en cause la création : l'événement existe bel et bien sur Discord.
    //
    // Écriture directe plutôt que synchronisation complète : un GET des
    // événements juste après la création tombe dans le même bucket Discord
    // (1 requête toutes les ~4 s) et récoltait un 429.
    let synced = false;
    try {
      await storeEvent(created);
      synced = true;
    } catch (err: any) {
      console.warn('[events/create] enregistrement local échoué', err?.message);
    }

    return res.status(201).json({
      ok: true,
      synced,
      event: {
        id: created.id,
        name: created.name,
        description: created.description ?? null,
        startAt: created.scheduled_start_time,
        endAt: created.scheduled_end_time ?? null,
        entityType: created.entity_type,
        location: created.entity_metadata?.location ?? null,
        url: `https://discord.com/events/${created.guild_id}/${created.id}`,
      },
    });
  } catch (err: any) {
    console.error('[events/create]', err);
    return res.status(502).json({ error: err.message });
  }
}
