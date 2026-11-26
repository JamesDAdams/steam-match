import { requireAccess } from '../access.ts';
import {
  getExternalGames,
  getExternalSummary,
  linkEpicAccount,
  linkGogAccount,
  MAX_ACCOUNTS_PER_PLATFORM,
  syncExternalAccount,
  unlinkExternalAccount,
} from '../external-sync.ts';
import { epicLoginUrl, parseEpicCode } from '../epic.ts';
import { gogLoginUrl, parseGogCode } from '../gog.ts';

/**
 * /api/external-accounts — comptes GOG et Epic d'un membre.
 *
 * GET    : comptes reliés (jamais de jeton) + URLs de connexion.
 * GET ?account=<id> : les jeux d'un compte (liste dépliée du profil).
 * POST   : { platform: 'gog'|'epic', code } pour relier, ou { id, action: 'resync' }.
 * DELETE : { id } pour détacher.
 *
 * Pas besoin d'avoir Steam : un membre peut très bien n'avoir qu'un compte
 * GOG. On utilise donc requireAccess, pas requireSteam.
 */
export default async function handler(req: any, res: any) {
  const ctx = await requireAccess(req, res);
  if (!ctx) return;

  const method = (req.method || 'GET').toUpperCase();

  try {
    if (method === 'GET') {
      const accountId = typeof req.query?.account === 'string' ? req.query.account.trim() : '';

      if (accountId) {
        const summary = await getExternalSummary(ctx.discordId);
        const owned = summary.accounts.find((a) => a.id === accountId);
        if (!owned) return res.status(404).json({ error: 'Compte introuvable.' });

        const games = await getExternalGames(accountId, 100);
        return res.status(200).json({ ok: true, account: owned, games });
      }

      const summary = await getExternalSummary(ctx.discordId);
      return res.status(200).json({
        ok: true,
        accounts: summary.accounts,
        maxPerPlatform: MAX_ACCOUNTS_PER_PLATFORM,
        login: { gog: gogLoginUrl(), epic: epicLoginUrl() },
      });
    }

    if (method === 'POST') {
      const body = (req.body ?? {}) as Record<string, unknown>;

      // Resynchronisation d'un compte existant.
      if (body.action === 'resync') {
        const id = String(body.id ?? '').trim();
        if (!id) return res.status(400).json({ error: 'Compte manquant.' });

        const summary = await getExternalSummary(ctx.discordId);
        if (!summary.accounts.some((a) => a.id === id)) {
          return res.status(404).json({ error: 'Compte introuvable.' });
        }

        const account = await syncExternalAccount(id);
        return res.status(200).json({
          ok: true,
          account: { id: account.id, gamesCount: account.gamesCount, lastError: account.lastError },
        });
      }

      // Liaison d'un nouveau compte.
      const platform = String(body.platform ?? '').trim().toLowerCase();
      const rawCode = String(body.code ?? '').trim();
      if (platform !== 'gog' && platform !== 'epic') {
        return res.status(400).json({ error: 'Plateforme inconnue (gog ou epic).' });
      }
      if (!rawCode) {
        return res.status(400).json({ error: 'Code de connexion manquant.' });
      }

      const code = platform === 'gog' ? parseGogCode(rawCode) : parseEpicCode(rawCode);
      if (!code) {
        return res.status(400).json({
          error:
            platform === 'gog'
              ? 'Code GOG illisible : colle l’URL de retour complète ou le code seul.'
              : 'Code Epic illisible : colle l’URL de retour ou le champ authorizationCode.',
        });
      }

      const account =
        platform === 'gog'
          ? await linkGogAccount(ctx.discordId, code)
          : await linkEpicAccount(ctx.discordId, code);

      return res.status(200).json({
        ok: true,
        account: {
          id: account.id,
          platform: account.platform,
          displayName: account.displayName,
          gamesCount: account.gamesCount,
          lastError: account.lastError,
        },
      });
    }

    if (method === 'DELETE') {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const id = String(body.id ?? '').trim();
      if (!id) return res.status(400).json({ error: 'Compte manquant.' });

      const removed = await unlinkExternalAccount(ctx.discordId, id);
      if (!removed) return res.status(404).json({ error: 'Compte introuvable.' });

      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: `Méthode ${method} non supportée.` });
  } catch (err: any) {
    console.error('[external-accounts]', err);
    return res.status(400).json({ error: err?.message ?? 'Opération impossible.' });
  }
}
