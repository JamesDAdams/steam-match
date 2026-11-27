import type { Config } from '@netlify/functions';
import { syncDiscordEvents } from '../../lib/events-sync.ts';

/**
 * Événements Discord : synchronisation périodique.
 *
 * POURQUOI CETTE TÂCHE : sans elle, la base ne se rafraîchissait que lorsqu'un
 * visiteur ouvrait la page Événements. Résultat : quelqu'un cochait
 * « Intéressé » sur Discord… et la description (qui recopie les intéressés)
 * restait figée pendant des heures, faute de synchronisation.
 *
 * La synchronisation relit les événements, rafraîchit la liste des intéressés
 * (au plus 3 événements par passage, toutes les 5 minutes) et réécrit la
 * description quand cette liste change — y compris pour les personnes qui ont
 * cliqué directement dans Discord.
 */
export default async () => {
  try {
    const { synced, syncedAt } = await syncDiscordEvents();
    console.log('[cron événements]', synced, 'événement(s) synchronisé(s)');
    return json({ ok: true, synced, syncedAt });
  } catch (err: any) {
    console.error('[cron événements] échec', err);
    return json({ ok: false, error: err?.message }, 500);
  }
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export const config: Config = {
  // Toutes les 5 minutes : assez court pour que le clic d'un membre sur
  // Discord apparaisse vite sur le site et dans la description.
  schedule: '*/5 * * * *',
};
