import {
  INTERACTION,
  discordAvatarUrl,
  isBotConfigured,
  verifyInteractionSignature,
} from '../discord-bot.ts';
import {
  parseButtonCustomId,
  toggleFromDiscord,
  type AnnouncementPayload,
} from '../event-announcement.ts';

/**
 * POST /api/discord/interactions — boutons des annonces d'événements.
 *
 * POURQUOI CETTE ROUTE
 * --------------------
 * Les boutons d'un message Discord sont renvoyés par Discord à l'« Interactions
 * Endpoint URL » de l'application (Developer Portal). Un bot qui ne se connecte
 * pas à la passerelle temps réel ne reçoit rien d'autre : c'est donc ici, dans
 * une simple fonction HTTP, que les clics arrivent.
 *
 * SÉCURITÉ
 * --------
 * Discord signe chaque requête (Ed25519). Sans vérification, n'importe qui
 * pourrait inscrire ou désinscrire des membres. On vérifie donc la signature
 * AVANT de lire quoi que ce soit d'autre, sur le corps brut.
 *
 * RÉPONSES (3 secondes maximum, sinon Discord affiche « échec de
 * l'interaction ») :
 *   • type 1 = « pong » (validation de l'URL par le portail)
 *   • type 7 = met à jour le message cliqué avec le nouvel embed
 *   • type 4 + flags 64 = message éphémère (visible par le seul cliqueur),
 *     utilisé pour les erreurs
 */

interface InteractionUser {
  id: string;
  username: string;
  global_name?: string | null;
  avatar?: string | null;
}

/** Note l'appel reçu (diagnostic admin). Ne bloque jamais la réponse. */
async function markInteraction(kind: 'ping' | 'clic'): Promise<void> {
  try {
    const { updateSettings } = await import('../settings.ts');
    await updateSettings({ lastInteractionAt: new Date(), lastInteractionKind: kind });
  } catch {
    /* trace seulement : jamais bloquant */
  }
}

function ephemeral(content: string) {
  return { type: 4, data: { content, flags: 64 } };
}

export default async function handler(req: any, res: any) {
  if ((req.method || 'GET').toUpperCase() !== 'POST') {
    return res.status(405).json({ error: `Méthode ${req.method} non supportée.` });
  }

  if (!isBotConfigured()) {
    return res.status(503).json({ error: 'Bot Discord non configuré.' });
  }

  /**
   * Corps BRUT pour la signature. Le routeur nous transmet `rawBody` : un
   * JSON.stringify du corps analysé ne redonnerait pas les mêmes octets (ordre
   * des clés, espaces) et la signature échouerait.
   */
  const rawBody =
    typeof req.rawBody === 'string' ? req.rawBody : JSON.stringify(req.body ?? {});

  // Netlify minuscule les en-têtes ; on ne s'y fie pas pour autant.
  const headers = req.headers ?? {};
  const header = (name: string): string | undefined => {
    const direct = headers[name] ?? headers[name.toLowerCase()];
    if (typeof direct === 'string') return direct;
    const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
    return key ? String(headers[key]) : undefined;
  };

  const verifyStartedAt = Date.now();
  const check = await verifyInteractionSignature({
    signature: header('x-signature-ed25519'),
    timestamp: header('x-signature-timestamp'),
    rawBody,
  });
  const verifyMs = Date.now() - verifyStartedAt;

  if (!check.ok) {
    // 401 : Discord n'accepte pas (et n'affichera) qu'une validation échouée.
    console.warn(
      `[interaction] signature refusée en ${verifyMs} ms : ${check.reason}`,
    );
    return res.status(401).json({ error: 'invalid request signature' });
  }

  let body: any = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      body = null;
    }
  }
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'corps invalide' });
  }

  // 1. Validation de l'URL par le portail Discord.
  if (body.type === 1) {
    console.log(`[interaction] ping validé en ${verifyMs} ms`);
    // Trace lisible depuis l'admin : c'est la PREUVE que l'URL déclarée dans
    // le portail Discord pointe bien ici.
    await markInteraction('ping');
    return res.status(200).json({ type: INTERACTION.PONG });
  }

  // 2. Clic sur un bouton (composant).
  if (body.type === 3) {
    return handleComponent(body, res);
  }

  // Autre type (commande…) : on n'en utilise pas.
  return res.status(400).json({ error: 'interaction non gérée' });
}

async function handleComponent(body: any, res: any) {
  const startedAt = Date.now();
  const customId: string = body?.data?.custom_id ?? '';
  const parsed = parseButtonCustomId(customId);
  if (!parsed) {
    return res.status(200).json(ephemeral('Bouton inconnu.'));
  }

  const rawUser: InteractionUser | undefined = body.member?.user ?? body.user;
  if (!rawUser?.id) {
    return res.status(200).json(ephemeral('Impossible d’identifier ton compte Discord.'));
  }

  const name =
    (body.member?.nick as string | undefined)?.trim() ||
    rawUser.global_name?.trim() ||
    rawUser.username;

  try {
    const result = await toggleFromDiscord({
      eventId: parsed.eventId,
      kind: parsed.kind,
      user: {
        id: rawUser.id,
        name: name || 'Membre',
        avatarUrl: discordAvatarUrl(rawUser.id, rawUser.avatar),
      },
    });

    if (!result.ok) {
      const messages: Record<string, string> = {
        'not-found': 'Cet événement n’existe plus.',
        closed: 'Cet événement est terminé : les inscriptions sont fermées.',
        'unknown-button': 'Bouton inconnu.',
      };
      return res.status(200).json(ephemeral(messages[result.reason] ?? 'Action impossible.'));
    }

    /**
     * La réponse EST la mise à jour du message (type 7) : pas de second appel à
     * Discord, donc pas de risque de dépasser les 3 secondes.
     */
    const response = {
      type: INTERACTION.UPDATE_MESSAGE,
      data: {
        embeds: result.payload.embeds,
        components: result.payload.components,
      } as Partial<AnnouncementPayload>,
    };

    /**
     * `toggleFromDiscord` a déjà réécrit la description de l'événement (avec un
     * budget de 900 ms). Si elle n'a pas eu le temps, la ligne reste marquée
     * « description à refaire » et la tâche planifiée la reprend.
     */
    console.log(
      `[interaction] ${parsed.kind} ${parsed.eventId} en ${Date.now() - startedAt} ms` +
        (result.descriptionUpdated ? ' (description à jour)' : ' (description en retard)'),
    );
    await markInteraction('clic');

    return res.status(200).json(response);
  } catch (err: any) {
    console.error('[discord/interactions]', err?.message);
    return res.status(200).json(ephemeral('Erreur du site : réessaie dans un instant.'));
  }
}
