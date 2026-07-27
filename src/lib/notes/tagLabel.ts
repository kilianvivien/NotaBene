/**
 * How a tag reads.
 *
 * Tags are stored as a namespace and a name because that is what makes them
 * facetable — `type:summary` is a query the search layer can answer. It is not
 * a thing to show a student. The sidebar was printing the storage form
 * verbatim, so a note the app itself had summarised appeared in the tag list as
 * `type:summary`, which looks like a bug in the app rather than a label.
 *
 * So: the namespace becomes a word ("Kind"), the name becomes a word
 * ("Summary"), and the two are shown as separate pieces so the UI can mute the
 * facet and leave the name legible. The stored value never changes — this is
 * presentation, and `viewQuery.ts` still queries `type:summary`.
 */
import type { TFunction } from 'i18next';
import type { TagNamespace } from '@/lib/schema';

export interface TagLabel {
  /** The namespace as a word, e.g. "Kind". Absent for a free tag. */
  facet?: string;
  /** The name as a word, e.g. "Summary". */
  name: string;
  /** Both, for a tooltip, a menu row, or anywhere only one string fits. */
  full: string;
}

/**
 * A raw tag name as a phrase: `mid-term_exam` reads as "Mid term exam".
 *
 * Only the first letter is capitalised. Title Case would be wrong for the
 * French half of the app and wrong for a tag like `pH`, and the user typed
 * whatever they typed — this is the lightest touch that stops a slug looking
 * like an identifier.
 */
function humanise(name: string): string {
  const words = name.replaceAll(/[-_]+/g, ' ').trim();
  return words ? words[0]!.toLocaleUpperCase() + words.slice(1) : name;
}

export function tagLabel(
  tag: { namespace: TagNamespace | null; name: string },
  t: TFunction,
): TagLabel {
  // Names the app generates itself get a real translation; anything the user
  // typed is shown as they typed it, only tidied.
  const name = tag.namespace
    ? t(`tags.value_${tag.namespace}_${tag.name}`, { defaultValue: humanise(tag.name) })
    : humanise(tag.name);

  if (!tag.namespace) return { name, full: name };

  const facet = t(`tags.facet_${tag.namespace}`, { defaultValue: tag.namespace });
  return { facet, name, full: `${facet} · ${name}` };
}

/** The storage form, for the places that genuinely need it: a search box the
 * user can then edit, and the MCP surface an agent reads. */
export function tagQuery(tag: { namespace: TagNamespace | null; name: string }): string {
  return tag.namespace ? `${tag.namespace}:${tag.name}` : tag.name;
}
