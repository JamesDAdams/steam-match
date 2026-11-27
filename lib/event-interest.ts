import { getDb } from '../db/index.ts';
import { discordEvents } from '../db/schema.ts';
import { eq, sql } from 'drizzle-orm';
import { getScheduledEvent, updateScheduledEvent } from './discord-bot.ts';

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

/**
 * Fusionne les trois sources en deux listes cohérentes.
 *
 * Les intéressés viennent de DEUX endroits : ceux qui ont cliqué sur Discord
 * (recopiés par la synchronisation) et ceux qui ont cliqué sur le site. Un même
 * membre peut être dans les deux : on déduplique par identifiant, la version
 * « site » (qui porte un horodatage) l'emportant. « Peut-être » exclut les
 * intéressés — l'un ou l'autre, jamais les deux.
 */
export function mergeInterestLists(
  discordInterested: { id: string; name: string; avatarUrl: string | null }[],
  siteInterested: InterestUser[],
  maybe: InterestUser[],
): EventLists {
  const merged = new Map<string, InterestUser>();
  for (const u of discordInterested) merged.set(u.id, { ...u, at: '' });
  for (const u of siteInterested) merged.set(u.id, u);

  const interested = [...merged.values()];
  const ids = new Set(interested.map((u) => u.id));

  return { interested, maybe: maybe.filter((u) => !ids.has(u.id)) };
}

/**
 * Retire le bloc « Inscriptions du site » d'une description Discord.
 *
 * Le bloc est placé EN TÊTE (c'est la première chose qu'on doit voir), suivi
 * d'une ligne vide puis de la description d'origine : on coupe donc du titre
 * jusqu'à cette ligne vide.
 */
export function stripSiteBlock(description: string | null): string | null {
  if (!description) return null;

  const start = description.indexOf(SITE_BLOCK_TITLE);
  if (start === -1) {
    const trimmed = description.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  const afterTitle = description.indexOf('\n', start);
  if (afterTitle === -1) return null;

  // Fin du bloc : la première ligne vide qui suit le titre.
  const blank = description.indexOf('\n\n', afterTitle);
  const base = blank === -1 ? '' : description.slice(blank + 2);
  const trimmed = base.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Description Discord = bloc d'inscriptions EN TÊTE, puis le texte d'origine. */
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
    lines.push(`👍 Intéressés (${interested.length}) : ${clip(interested, 320)}`);
  }
  if (maybe.length > 0) {
    lines.push(`❔ Peut-être (${maybe.length}) : ${clip(maybe, 320)}`);
  }

  const block = lines.join('\n');
  const keptBase = base ? base.trim() : '';
  const room = MAX_DESCRIPTION - block.length - 2;
  const body = keptBase && room > 0 ? `\n\n${keptBase.slice(0, room).trimEnd()}` : '';
  return `${block}${body}`.slice(0, MAX_DESCRIPTION);
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
 * Ajoute ou retire quelqu'un d'une liste, de façon ATOMIQUE et en UNE SEULE
 * requête.
 *
 * POURQUOI UNE SEULE : les inscriptions depuis un bouton Discord doivent
 * répondre en moins de 3 secondes, sinon Discord affiche « l'application n'a
 * pas répondu à temps ». Chaque aller-retour vers la base coûte ~100-250 ms :
 * les quatre requêtes d'avant (ajout, exclusivité, relecture) suffisaient à
 * faire expirer l'interaction. Ici tout est fait d'un coup, sous verrou de
 * ligne : deux clics simultanés ne peuvent pas s'écraser.
 *
 * `site_interested_users` / `maybe_users` s'excluent : ajouter dans l'une
 * retire de l'autre.
 */
export type InterestKind = 'interested' | 'maybe' | 'out';

export async function applyInterest(
  eventId: string,
  kind: InterestKind,
  user: { id: string; name: string; avatarUrl: string | null },
  active: boolean,
): Promise<{ lists: EventLists; row: Record<string, any> } | null> {
  const db = getDb();
  const interested = sql.raw('site_interested_users');
  const maybe = sql.raw('maybe_users');
  const entry = JSON.stringify([{ ...user, at: new Date().toISOString() }]);

  /** Retrait d'une liste, en conservant l'ordre chronologique. */
  const removal = (column: any) => sql`COALESCE((
    SELECT jsonb_agg(u ORDER BY u->>'at')
    FROM jsonb_array_elements(${column}) AS u
    WHERE u->>'id' <> ${user.id}
  ), '[]'::jsonb)`;

  /**
   * Trois boutons :
   *   • « Je participe »      → ajoute aux intéressés, retire des « peut-être »
   *   • « Peut-être »         → l'inverse
   *   • « Je ne participe plus » → retire des DEUX listes
   */
  /**
   * EXCLUSIVITÉ : « je participe » et « peut-être » ne peuvent pas coexister.
   * Choisir l'un retire donc de l'autre, dans la même requête.
   */
  const interestedExpr =
    kind === 'interested' && active
      ? sql`${interested} || ${entry}::jsonb`
      : kind === 'out' || (kind === 'interested' && !active) || (kind === 'maybe' && active)
        ? removal(interested)
        : sql`${interested}`;

  const maybeExpr =
    kind === 'maybe' && active
      ? sql`${maybe} || ${entry}::jsonb`
      : kind === 'out' || (kind === 'maybe' && !active) || (kind === 'interested' && active)
        ? removal(maybe)
        : sql`${maybe}`;

  /**
   * `RETURNING *` renvoie la ligne ENTIÈRE (listes, nom, description, dates,
   * jeu) : l'appelant construit le message d'annonce sans relire la base.
   */
  const result = (await db.execute(sql`
    UPDATE discord_events
    SET site_interested_users = ${interestedExpr},
        maybe_users = ${maybeExpr},
        description_dirty = true
    WHERE id = ${eventId}
      AND (
        ${active} = false
        OR ${kind === 'out'}
        OR NOT EXISTS (
          -- déjà dans la liste visée : rien à ajouter (clic répété)
          SELECT 1 FROM jsonb_array_elements(${kind === 'maybe' ? maybe : interested}) AS u
          WHERE u->>'id' = ${user.id}
        )
      )
    RETURNING *, (
      SELECT row_to_json(g) FROM game_cache g WHERE g.appid = discord_events.game_appid
    ) AS game
  `)) as unknown as { rows?: Record<string, any>[] };

  const row = result.rows?.[0];
  if (!row) return null;

  const toList = (value: unknown): InterestUser[] =>
    Array.isArray(value) ? (value as InterestUser[]) : [];

  return {
    lists: { interested: toList(row.site_interested_users), maybe: toList(row.maybe_users) },
    row,
  };
}

/** Variante « listes seulement », utilisée par l'inscription depuis le site. */
export async function setInterest(
  eventId: string,
  kind: InterestKind,
  user: { id: string; name: string; avatarUrl: string | null },
  active: boolean,
): Promise<EventLists | null> {
  const applied = await applyInterest(eventId, kind, user, active);
  return applied ? applied.lists : null;
}

/**
 * Recopie les listes dans la description de l'événement Discord.
 *
 * La description d'origine est conservée sous le bloc, telle quelle. Elle est
 * relue depuis Discord si elle manque en base : sans cela, composer à partir de
 * « rien » produirait une description vide, c'est-à-dire la PERTE du texte
 * écrit par l'organisateur.
 */
export async function syncDescription(eventId: string): Promise<void> {
  const db = getDb();
  const [row] = await db
    .select({
      description: discordEvents.description,
      interested: discordEvents.siteInterestedUsers,
      maybe: discordEvents.maybeUsers,
      discordInterested: discordEvents.interestedUsers,
    })
    .from(discordEvents)
    .where(eq(discordEvents.id, eventId))
    .limit(1);

  if (!row) return;

  await syncDescriptionWith({
    eventId,
    description: row.description ?? null,
    siteInterested: (row.interested ?? []) as InterestUser[],
    maybe: (row.maybe ?? []) as InterestUser[],
    discordInterested: (row.discordInterested ?? []) as {
      id: string;
      name: string;
      avatarUrl: string | null;
    }[],
  });
}

/** Même chose, à partir d'une ligne déjà chargée (clic sur un bouton). */
export async function syncDescriptionWith(input: {
  eventId: string;
  description: string | null;
  siteInterested: InterestUser[];
  maybe: InterestUser[];
  discordInterested: { id: string; name: string; avatarUrl: string | null }[];
}): Promise<void> {
  const db = getDb();
  const { eventId } = input;

  /**
   * Les personnes intéressées SUR DISCORD comptent aussi : la description
   * reflète donc les deux sources, sans doublon (un membre peut être
   * intéressé sur Discord ET avoir cliqué sur le site).
   */
  const lists = mergeInterestLists(input.discordInterested, input.siteInterested, input.maybe);

  let base = stripSiteBlock(input.description);

  /**
   * Description d'origine absente en base alors qu'il y a des inscrits : on va
   * la chercher chez Discord et on la mémorise. Écrire le bloc seul
   * effacerait définitivement le texte de l'événement.
   */
  if (base === null && (lists.interested.length > 0 || lists.maybe.length > 0)) {
    const live = await getScheduledEvent(eventId).catch(() => null);
    base = stripSiteBlock(live?.description ?? null);
    if (base) {
      await db
        .update(discordEvents)
        .set({ description: base })
        .where(eq(discordEvents.id, eventId))
        .catch(() => undefined);
    }
  }

  const description = composeDescription(base, lists);

  // Rien à écrire ET rien à effacer : on évite un PATCH inutile (et destructeur).
  if (description !== null) {
    await updateScheduledEvent(eventId, { description });
  }

  // Reprise faite : plus rien à rattraper pour la tâche planifiée.
  await db
    .update(discordEvents)
    .set({ descriptionDirty: false })
    .where(eq(discordEvents.id, eventId))
    .catch(() => undefined);
}
