import { getDb } from '../../db/index.ts';
import { twitchLinks, discordUsers } from '../../db/schema.ts';
import { eq } from 'drizzle-orm';
import { optionalAccess, requireAccess } from '../access.ts';
import { checkChannelExists, getChannelsState, parseTwitchLogin } from '../twitch.ts';

/**
 * /api/twitch — chaînes Twitch des membres.
 *
 * GET    : liste des créateurs liés + statut live (cache 60 s côté serveur).
 * POST   : { value } pour lier sa chaîne (URL Twitch ou pseudo).
 * DELETE : délie sa chaîne.
 *
 * Le live n'est jamais stocké en base : il change trop souvent. Seul le lien
 * l'est, et le statut est interrogé à la demande.
 */
export default async function handler(req: any, res: any) {
  const method = (req.method || 'GET').toUpperCase();

  // Lecture publique (la page Twitch est ouverte à tous) ; les modifications
  // exigent une session.
  let ctx = await optionalAccess(req);
  if (method !== 'GET') {
    ctx = await requireAccess(req, res);
    if (!ctx) return;
  }

  try {
    const db = getDb();

    /* ── Liste ─────────────────────────────────────────────────────── */
    if (method === 'GET') {
      const rows = await db
        .select({
          discordId: twitchLinks.discordId,
          login: twitchLinks.login,
          displayName: twitchLinks.displayName,
          avatarUrl: twitchLinks.avatarUrl,
          linkedAt: twitchLinks.linkedAt,
          discordName: discordUsers.globalName,
          discordUsername: discordUsers.username,
          discordAvatar: discordUsers.avatarUrl,
        })
        .from(twitchLinks)
        .leftJoin(discordUsers, eq(discordUsers.discordId, twitchLinks.discordId));

      const states = await getChannelsState(rows.map((r) => r.login));

      const streamers = rows
        .map((r) => {
          const state = states[r.login.toLowerCase()];
          return {
            // Pas d'identifiant Discord : la page est publique, inutile
            // d'exposer un identifiant unique à des visiteurs anonymes.
            memberName: r.discordName || r.discordUsername || 'Membre',
            login: r.login,
            displayName: state?.displayName || r.displayName || r.login,
            avatarUrl: state?.avatarUrl || r.avatarUrl,
            channelUrl: `https://www.twitch.tv/${r.login}`,
            isLive: state?.isLive ?? false,
            title: state?.title ?? null,
            game: state?.game ?? null,
            viewers: state?.viewers ?? null,
            startedAt: state?.startedAt ?? null,
            thumbnailUrl: state?.thumbnailUrl ?? null,
          };
        })
        .sort((a, b) => {
          // En direct d'abord, puis par nombre de spectateurs, puis par nom.
          if (a.isLive !== b.isLive) return a.isLive ? -1 : 1;
          if ((b.viewers ?? 0) !== (a.viewers ?? 0)) return (b.viewers ?? 0) - (a.viewers ?? 0);
          return a.displayName.localeCompare(b.displayName, 'fr');
        });

      const mine = ctx ? (rows.find((r) => r.discordId === ctx!.discordId) ?? null) : null;

      return res.status(200).json({
        ok: true,
        // Le repli GraphQL fournit les mêmes informations que l'API
        // officielle ; le champ reste pour distinguer une source dégradée.
        richStatus: true,
        streamers,
        live: streamers.filter((s) => s.isLive),
        mine: mine
          ? {
              login: mine.login,
              displayName: mine.displayName,
              avatarUrl: mine.avatarUrl,
              channelUrl: `https://www.twitch.tv/${mine.login}`,
              linkedAt: mine.linkedAt,
            }
          : null,
      });
    }

    /* ── Lier ──────────────────────────────────────────────────────── */
    if (method === 'POST') {
      const login = parseTwitchLogin(String((req.body ?? {}).value ?? ''));
      if (!login) {
        return res.status(400).json({
          error:
            'Chaîne Twitch invalide. Colle l’adresse de ta chaîne (https://www.twitch.tv/pseudo) ou son pseudo.',
        });
      }

      const channel = await checkChannelExists(login);
      if (!channel) {
        return res.status(404).json({
          error: 'Cette chaîne Twitch est introuvable. Vérifie le pseudo.',
        });
      }

      const values = {
        discordId: ctx!.discordId,
        login,
        displayName: channel.displayName ?? login,
        avatarUrl: channel.avatarUrl ?? null,
      };

      await db
        .insert(twitchLinks)
        .values(values)
        .onConflictDoUpdate({
          target: twitchLinks.discordId,
          set: { login: values.login, displayName: values.displayName, avatarUrl: values.avatarUrl },
        });

      return res.status(200).json({
        ok: true,
        channel: { ...values, channelUrl: `https://www.twitch.tv/${login}` },
      });
    }

    /* ── Délier ────────────────────────────────────────────────────── */
    if (method === 'DELETE') {
      await db.delete(twitchLinks).where(eq(twitchLinks.discordId, ctx!.discordId));
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: `Méthode ${method} non supportée.` });
  } catch (err: any) {
    console.error('[twitch]', err);
    return res.status(500).json({ error: err.message });
  }
}
