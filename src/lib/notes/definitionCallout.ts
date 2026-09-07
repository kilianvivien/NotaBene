/**
 * A definition, as a block the note can hold.
 *
 * A callout and not a new node type, for the reason the diagram gives for being
 * a drawing: an "encadré" already exports to HTML, PDF, DOCX and Markdown,
 * already round-trips through `> [!INFO]`, and is already editable — a student
 * who disagrees with a word of it can fix that word. A `definition` node would
 * have needed a schema bump and five export paths to end up looking the same.
 *
 * Nothing here records that a model wrote it. The provenance of an AI edit
 * lives in version history, where `updateNoteCommand` puts it; stamping "AI" in
 * the prose would put it in the essay the student hands in.
 */
import type { AiDefinitionResponse, DocNode } from '@/lib/schema';

function text(value: string, marks?: DocNode['marks']): DocNode {
  return marks ? { type: 'text', text: value, marks } : { type: 'text', text: value };
}

/**
 * The headword, then the definition, in one paragraph.
 *
 * One paragraph rather than a heading and a body: this sits inside the flow of
 * a lecture note, where a heading would break the document's outline — and the
 * document map is built from headings, so a box defining "syllogisme" would
 * appear there as a section of the lecture.
 *
 * `inContext` earns a second paragraph when the model sent one, because "in
 * this note it means…" is a different claim from the definition and running
 * the two together makes it read as part of it.
 */
export function definitionCallout(definition: AiDefinitionResponse): DocNode {
  const content: DocNode[] = [
    {
      type: 'paragraph',
      content: [
        text(definition.term, [{ type: 'bold' }]),
        // An em dash with spaces, which is what the callout reads as in both
        // shipped locales; a colon would be wrong in French typography without
        // its own space and right in English with none.
        text(' — '),
        text(definition.definition),
      ],
    },
  ];

  if (definition.inContext?.trim()) {
    content.push({
      type: 'paragraph',
      content: [text(definition.inContext.trim(), [{ type: 'italic' }])],
    });
  }

  return { type: 'callout', attrs: { kind: 'info' }, content };
}
