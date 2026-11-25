import { requireAdmin } from '../access.ts';
import {
  getBotChannelAccess,
  getBotIdentity,
  getBotPermissions,
  guildId,
  isBotConfigured,
  listEventChannels,
} from '../discord-bot.ts';

/**
 * GET /api/events/channels — salons vocaux et scènes du serveur, plus l'état
 * du bot (identité et permissions).
 *
 * Sert à alimenter le modal « Créer un événement ». L'identité du bot est
 * affichée parce qu'elle explique la plupart des 403 : si le jeton configuré
 * appartient à une autre application Discord que celle qu'on a autorisée sur
 * le serveur, l'admin doit pouvoir le voir immédiatement.
 *
 * Réservé à l'admin, comme la création.
 *
 * On répond toujours 200 : une liste vide avec un message d'erreur est plus
 * simple à afficher qu'un 502, et ce n'est qu'une donnée d'assistance.
 */
export default async function handler(req: any, res: any) {
  if ((req.method || 'GET').toUpperCase() !== 'GET') {
    return res.status(405).json({ error: `Méthode ${req.method} non supportée.` });
  }

  const ctx = await requireAdmin(req, res);
  if (!ctx) return;

  if (!isBotConfigured()) {
    return res.status(200).json({
      ok: true,
      configured: false,
      guildId: null,
      channels: [],
      bot: null,
      error: null,
    });
  }

  // Identité et permissions : utiles même si la liste des salons échoue.
  let bot: {
    id: string;
    username: string;
    canCreateEvents: boolean;
    canManageEvents: boolean;
  } | null = null;
  let permissionsError: string | null = null;

  try {
    const [identity, perms] = await Promise.all([
      getBotIdentity(),
      // Relecture forcée : l'admin ouvre ce modal justement pour diagnostiquer.
      getBotPermissions({ force: true }),
    ]);
    bot = {
      id: identity.id,
      username: identity.username,
      canCreateEvents: perms.createEvents,
      canManageEvents: perms.manageEvents,
    };
  } catch (err: any) {
    permissionsError = err?.message ?? 'Permissions illisibles.';
  }

  try {
    const channels = await listEventChannels();

    // Accès par salon : Discord exige « Voir » et « Se connecter » pour un
    // événement vocal. Une liste sans cette information laisserait l'admin
    // choisir un salon qui échouera en 403.
    let access: Awaited<ReturnType<typeof getBotChannelAccess>> = {};
    try {
      // Relecture forcée : l'admin ouvre ce modal après avoir corrigé des
      // permissions, il doit voir l'état réel et non un cache de 2 minutes.
      access = await getBotChannelAccess({ force: true });
    } catch {
      /* accès inconnu : on ne bloque pas, Discord tranchera */
    }

    return res.status(200).json({
      ok: true,
      configured: true,
      guildId: guildId(),
      channels: channels.map((c) => ({
        id: c.id,
        name: c.name,
        type: c.type,
        canView: access[c.id]?.canView ?? true,
        canConnect: access[c.id]?.canConnect ?? true,
        grantingRoles: access[c.id]?.grantingRoles ?? [],
      })),
      bot,
      error: permissionsError,
    });
  } catch (err: any) {
    console.error('[events/channels]', err);
    return res.status(200).json({
      ok: true,
      configured: true,
      guildId: guildId(),
      channels: [],
      bot,
      error: err.message,
    });
  }
}
