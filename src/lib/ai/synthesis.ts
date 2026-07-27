/**
 * Synthesis: one or more notes in, a new note out.
 *
 * A new note rather than an edit, always. A summary that overwrote its source
 * would be the one AI action a student could not undo by not accepting it, and
 * the whole point of a revision sheet is to sit beside the lecture note, not
 * replace it.
 */
import { docToMarkdown, markdownToDoc } from '@/editor/markdown';
import { AiSynthesisResponseSchema, type Note, type NoteDoc } from '@/lib/schema';
import { runAi, type AiRunOptions } from './client';
import { parseModelJson } from './json';
import { synthesisPrompt, type SynthesisStyle } from './prompts';
import type { ResolvedProvider } from './protocols';

export type { SynthesisStyle };

export interface SynthesisRequest {
  provider: ResolvedProvider;
  sources: Pick<Note, 'id' | 'title' | 'doc'>[];
  style: SynthesisStyle;
  language: string;
}

export interface SynthesisResult {
  title: string;
  doc: NoteDoc;
}

export async function requestSynthesis(
  request: SynthesisRequest,
  options: AiRunOptions = {},
): Promise<SynthesisResult> {
  if (!request.sources.length) throw new Error('select at least one note to summarize');

  const text = await runAi(
    {
      provider: request.provider,
      messages: synthesisPrompt({
        style: request.style,
        sources: request.sources.map((note) => ({
          title: note.title,
          markdown: docToMarkdown(note.doc),
        })),
        language: request.language,
      }),
      maxTokens: 8_000,
      temperature: 0.3,
      json: true,
      stream: false,
    },
    options,
  );

  const response = parseModelJson(AiSynthesisResponseSchema, text);
  const doc = markdownToDoc(response.markdown);

  return {
    title: response.title.trim(),
    doc: withSourceLinks(doc, request.sources),
  };
}

/**
 * Append the "from" section.
 *
 * The links are built here, from note ids we already hold, rather than asked
 * for in the prompt — a model inventing a `[[link]]` to a note that does not
 * exist would leave the student clicking through to a create-new-note dialog
 * for a lecture they never wrote.
 */
function withSourceLinks(
  doc: NoteDoc,
  sources: Pick<Note, 'id' | 'title'>[],
): NoteDoc {
  const links = sources.map((note) => ({
    type: 'listItem',
    content: [
      {
        type: 'paragraph',
        content: [
          {
            type: 'wikiLink',
            attrs: { title: note.title || 'Untitled', noteId: note.id },
          },
        ],
      },
    ],
  }));

  return {
    type: 'doc',
    content: [
      ...doc.content,
      { type: 'horizontalRule' },
      { type: 'bulletList', content: links },
    ],
  };
}
