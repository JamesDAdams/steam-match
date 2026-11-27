import { getDb } from '../db/index.ts';
import { discordEvents } from '../db/schema.ts';
import { eq, sql } from 'drizzle-orm';
import { updateScheduledEvent } from './discord-bot.ts';

/**
 * Inscriptions aux événements, depuis le site.
 *
 * POURQUOI CE MODULE : Discord ne permet PAS à un bot de cocher « Intéressé »
 * à la place d'un membre (aucune route d'écriture sur les intéressés). On tient
 * donc nos propres listes, et on recopie le résultat dans la **description** de
 * l'événement Discord — visible par tout le serveur, y compris ceux qui ne
 * passent jamais par le site.
 *
 * DEUX LISTES :
 *   • « Intéressé »  → siteInterestedUsers
 *   • « Peut-être »  → maybeUsers
 *
 * Les deux sont recopiées dans la description, sous un bloc balisé, pour être
 * posées et re-posées sans jamais écraser la description écrite à la main.
 */

/**
 * Titre du bloc géré par le site. On le recherche SANS les sauts de ligne qui
 * le précèdent : une description déjà passée par Discord peut arriver avec un
 * seul « \n », et le bloc ne serait alors jamais reconnu (il se dupliquerait à
 * chaque mise à jour).
 */
export const SITE_BLOCK_TITLE = '━━ Inscriptions du site ━━';

/** Le bloc, tel qu'il est ajouté à la description. */
export const SITE_BLOCK_MARKER = `\n\n${SITE_BLOCK_TITLE}`;

/** Discord plafonne la description d'un événement à 1000 caractères. */
const MAX_DESCRIPTION = 1000;

export interface InterestUser {
  id: string;
  name: string;
  avatarUrl: string | null;
  at: string;
}

export interface EventLists {
  interested: InterestUser[];
  maybe: InterestUser[];
}

/** Retire le bloc « Inscriptions du site » d'une description Discord. */
export function stripSiteBlock(description: string | null): string | null {
  if (!description) return null;
  const index = description.indexOf(SITE_BLOCK_TITLE);
  const base = index >= 0 ? description.slice(0, index) : description;
  const trimmed = base.trimEnd();
  return trimmed.length > 0 ? trimmed : null;
}

/** Description Discord = texte d'origine + bloc d'inscriptions. */
export function composeDescription(
  base: string | null,
  lists: EventLists,
): string | null {
  const interested = lists.interested.map((u) => u.name);
  const maybe = lists.maybe.map((u) => u.name);

  if (interested.length === 0 && maybe.length === 0) {
    return base ? base.slice(0, MAX_DESCRIPTION) : null;
  }

  const lines: string[] = [SITE_BLOCK_TITLE];
  if (interested.length > 0) {
    lines.push(`✅ Intéressés (${interested.length}) : ${clip(interested, 320)}`);
  }
  if (maybe.length > 0) {
    lines.push(`❔ Peut-être (${maybe.length}) : ${clip(maybe, 320)}`);
  }

  // On garde la description d'origine tant qu'il y a de la place : c'est elle
  // qui porte l'information utile.
  const block = `\n\n${lines.join('\n')}`;
  const room = MAX_DESCRIPTION - block.length;
  const keptBase = base && room > 0 ? base.slice(0, room).trimEnd() : '';
  return `${keptBase}${block}`.slice(0, MAX_DESCRIPTION);
}

/** Liste de prénoms tronquée proprement (pas de nom coupé en deux). */
function clip(names: string[], maxLength: number): string {
  let out = '';
  let shown = 0;
  for (const name of names) {
    const next = out ? `${out}, ${name}` : name;
    if (next.length > maxLength) break;
    out = next;
    shown++;
  }
  const rest = names.length - shown;
  return rest > 0 ? `${out}… +${rest}` : out;
}

/**
 * Ajoute ou retire quelqu'un d'une liste, de façon ATOMIQUE.
 *
 * C'est ce qui rend deux clics simultanés sûrs : la modification se fait en
 * une seule requête SQL (donc sous verrou de ligne), jamais par un
 * « lire → modifier → écrire » côté application.
 */
/** Au moins un clic simultané : chaque écriture est une requête unique, donc
 *  protégée par le verrou de ligne — jamais de « lire puis écrire ». */
export async function setInterest(
  eventId: string,
  kind: 'interested' | 'maybe',
  user: { id: string; name: string; avatarUrl: string | null },
  active: boolean,
): Promise<EventLists | null> {
  const db = getDb();
  const column = sql.raw(kind === 'interested' ? 'site_interested_users' : 'maybe_users');
  const entry = JSON.stringify([{ ...user, at: new Date().toISOString() }]);

  if (active) {
    // Ajout SEULEMENT si la personne n'est pas déjà dans la liste.
    await db.execute(sql`
      UPDATE discord_events
      SET ${column} = ${column} || ${entry}::jsonb
      WHERE id = ${eventId}
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(${column}) AS u WHERE u->>'id' = ${user.id}
        )
    `);
  } else {
    // Retrait, en conservant l'ordre chronologique.
    await db.execute(sql`
      UPDATE discord_events
      SET ${column} = COALESCE((
        SELECT jsonb_agg(u ORDER BY u->>'at')
        FROM jsonb_array_elements(${column}) AS u
        WHERE u->>'id' <> ${user.id}
      ), '[]'::jsonb)
      WHERE id = ${eventId}
    `);
  }

  const [row] = await db
    .select({
      interested: discordEvents.siteInterestedUsers,
      maybe: discordEvents.maybeUsers,
    })
    .from(discordEvents)
    .where(eq(discordEvents.id, eventId))
    .limit(1);

  if (!row) return null;

  const toList = (value: unknown): InterestUser[] =>
    Array.isArray(value) ? (value as InterestUser[]) : [];

  return { interested: toList(row.interested), maybe: toList(row.maybe) };
}

/**
 * Recopie les listes dans la description de l'événement Discord.
 *
 * Appelée après chaque changement : le dernier appelant relit l'état complet,
 * donc deux clics rapprochés convergent vers la même description.
 */
export async function syncDescription(eventId: string): Promise<void> {
  const db = getDb();
  const [row] = await db
    .select({
      description: discordEvents.description,
      interested: discordEvents.siteInterestedUsers,
      maybe: discordEvents.maybeUsers,
    })
    .from(discordEvents)
    .where(eq(discordEvents.id, eventId))
    .limit(1);

  if (!row) return;

  const description = composeDescription(stripSiteBlock(row.description), {
    interested: (row.interested ?? []) as InterestUser[],
    maybe: (row.maybe ?? []) as InterestUser[],
  });

  await updateScheduledEvent(eventId, { description });
}
