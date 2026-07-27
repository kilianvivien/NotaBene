/**
 * The study features: mind maps, flashcards, and the podcast.
 *
 * Beside `aiCommands.ts` rather than inside it because these three share a
 * shape the earlier features do not: each produces an artefact the student
 * looks at *before* deciding what to do with it, and each then has more than
 * one destination — a block in the note, a file for Anki, a WAV on disk. The
 * rule from the AI core still holds and is what every write here goes through:
 * a model's output is parsed by a schema, the user says yes, and the write
 * lands via `updateNoteCommand` with `source: 'ai'` so the pre-edit note is in
 * version history.
 *
 * Generating an artefact is not a mutation and does not snapshot anything. It
 * lives here anyway, for the same reason `askAboutNotesCommand` does: provider
 * resolution should have one implementation, not four.
 */
import { markdownToDoc } from '@/editor/markdown';
import { dialog, exporter, library, tts, type TtsVoice } from '@/lib/adapters';
import {
  requestFlashcards,
  requestMindMap,
  requestPodcastScript,
  type AiRunOptions,
  type FlashcardStyle,
  type MindMapResult,
  type PodcastMode,
} from '@/lib/ai';
import { ankiFileName, deckToAnkiTsv } from '@/lib/export/anki';
import { concatWav } from '@/lib/podcast/wav';
import type { DocNode, FlashcardDeck, Note, PodcastScript } from '@/lib/schema';
import { useEditorStore } from '@/lib/state/editorStore';
import { language, providerFor } from './aiCommands';
import { updateNoteCommand } from './noteCommands';
import { fail, ok, type CommandResult } from './types';

const AI = { source: 'ai' } as const;

/** Load notes by id, skipping the ones that have gone. Flushing first matters
 * for the same reason it does in rewrite: autosave debounces, and summarising
 * the note as it was 800 ms ago is summarising the wrong note. */
async function loadNotes(noteIds: string[]): Promise<Note[]> {
  await useEditorStore.getState().flush();
  const notes: Note[] = [];
  for (const noteId of noteIds) {
    const note = await library.getNote(noteId);
    if (note) notes.push(note);
  }
  return notes;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Append blocks to a note and reopen it, so the student sees what landed. */
async function appendToNote(
  noteId: string,
  blocks: DocNode[],
): Promise<CommandResult<Note>> {
  const note = await library.getNote(noteId);
  if (!note) return fail('not_found', `no note ${noteId}`);

  const result = await updateNoteCommand(
    { noteId, doc: { type: 'doc', content: [...note.doc.content, ...blocks] } },
    AI,
  );
  if (result.ok) await useEditorStore.getState().openNote(noteId);
  return result;
}

// -- Mind map ----------------------------------------------------------------

export async function proposeMindMapCommand(
  noteId: string,
  options: AiRunOptions = {},
): Promise<CommandResult<MindMapResult>> {
  const [note] = await loadNotes([noteId]);
  if (!note) return fail('not_found', `no note ${noteId}`);

  const lookup = await providerFor('mindMap');
  if (!lookup.ok) return fail('not_supported', lookup.reason);

  try {
    return ok(
      await requestMindMap(
        { provider: lookup.provider, source: note, language: language() },
        options,
      ),
    );
  } catch (error) {
    return fail('invalid_input', message(error));
  }
}

/**
 * Put the map in the note.
 *
 * Both the tree and the rendered SVG go on the node. The SVG is what every
 * export path draws — keeping the render out of the node view is what stops a
 * mind map from being a thing you can only see inside the app.
 */
export async function insertMindMapCommand(
  noteId: string,
  result: MindMapResult,
): Promise<CommandResult<Note>> {
  return appendToNote(noteId, [
    {
      type: 'mindMap',
      attrs: { data: result.map, svg: result.svg, title: result.map.title },
    },
  ]);
}

// -- Flashcards --------------------------------------------------------------

export interface FlashcardInput {
  noteIds: string[];
  style: FlashcardStyle;
  count: number;
}

export async function proposeFlashcardsCommand(
  input: FlashcardInput,
  options: AiRunOptions = {},
): Promise<CommandResult<FlashcardDeck>> {
  const notes = await loadNotes(input.noteIds);
  if (!notes.length) return fail('not_found', 'none of those notes exist');

  const lookup = await providerFor('flashcards');
  if (!lookup.ok) return fail('not_supported', lookup.reason);

  try {
    return ok(
      await requestFlashcards(
        {
          provider: lookup.provider,
          sources: notes,
          style: input.style,
          count: input.count,
          language: language(),
        },
        options,
      ),
    );
  } catch (error) {
    return fail('invalid_input', message(error));
  }
}

/**
 * Write the deck into the note as a self-test section.
 *
 * Answers go inside a toggle so the section is usable as revision on its own —
 * scroll, read the question, cover nothing, open the toggle. This is also what
 * makes a deck outlive the dialog: NotaBene stores notes, not decks, and a card
 * that only exists in a modal is a card that is gone when you close it.
 */
export async function saveFlashcardsToNoteCommand(
  noteId: string,
  deck: FlashcardDeck,
): Promise<CommandResult<Note>> {
  if (!deck.cards.length) return fail('invalid_input', 'the deck is empty');

  const markdown = [
    `## ${deck.title}`,
    '',
    ...deck.cards.flatMap((card) => [
      `**${card.front.replaceAll('\n', ' ')}**`,
      '',
      ...(card.hint ? [`*${card.hint.replaceAll('\n', ' ')}*`, ''] : []),
      `> [!TOGGLE Answer]`,
      `> ${card.back.replaceAll('\n', ' ')}`,
      '',
    ]),
  ].join('\n');

  return appendToNote(noteId, [
    { type: 'horizontalRule' },
    ...markdownToDoc(markdown).content,
  ]);
}

export async function exportFlashcardsCommand(
  deck: FlashcardDeck,
  options: { deckPrefix?: string; destination?: string } = {},
): Promise<CommandResult<string | undefined>> {
  if (!deck.cards.length) return fail('invalid_input', 'the deck is empty');

  const name = ankiFileName(deck);
  const destination =
    options.destination ??
    (await dialog.saveFile({
      defaultPath: name,
      filters: [{ name: 'Anki', extensions: ['txt'] }],
    }));
  if (!destination) return fail('not_supported', 'export cancelled');

  try {
    const result = await exporter.write({
      format: 'anki',
      destination,
      suggestedName: name,
      files: [
        {
          path: name,
          contents: new Blob([deckToAnkiTsv(deck, { deckPrefix: options.deckPrefix })], {
            type: 'text/plain;charset=utf-8',
          }),
        },
      ],
    });
    return result.ok
      ? ok(result.path)
      : fail('storage_failed', result.error ?? 'export failed');
  } catch (error) {
    return fail('storage_failed', message(error));
  }
}

// -- Podcast -----------------------------------------------------------------

export interface PodcastInput {
  noteIds: string[];
  mode: PodcastMode;
  minutes: number;
}

export async function proposePodcastScriptCommand(
  input: PodcastInput,
  options: AiRunOptions = {},
): Promise<CommandResult<PodcastScript>> {
  const notes = await loadNotes(input.noteIds);
  if (!notes.length) return fail('not_found', 'none of those notes exist');

  const lookup = await providerFor('podcast');
  if (!lookup.ok) return fail('not_supported', lookup.reason);

  try {
    return ok(
      await requestPodcastScript(
        {
          provider: lookup.provider,
          sources: notes,
          mode: input.mode,
          minutes: input.minutes,
          language: language(),
        },
        options,
      ),
    );
  } catch (error) {
    return fail('invalid_input', message(error));
  }
}

export interface SpokenSegment {
  audio: Blob;
  durationMs: number;
}

/**
 * Voices for the podcast, narrowed to the app's language.
 *
 * A French revision episode read by an American voice is unusable, and the full
 * macOS voice list runs to well over a hundred entries across forty languages.
 * Falling back to the whole list rather than to nothing matters for the user
 * who has installed exactly one voice and it is not in their locale.
 */
export async function listPodcastVoicesCommand(
  locale: string,
): Promise<CommandResult<TtsVoice[]>> {
  try {
    if (!(await tts.isAvailable())) {
      return fail('not_supported', 'text-to-speech is not available on this system');
    }
    const voices = await tts.listVoices();
    const matching = voices.filter((voice) =>
      voice.locale.toLowerCase().startsWith(locale.slice(0, 2).toLowerCase()),
    );
    return ok(matching.length ? matching : voices);
  } catch (error) {
    return fail('not_supported', message(error));
  }
}

/**
 * Speak a script, one segment at a time.
 *
 * Segment by segment rather than in one call for two reasons the student can
 * feel: the player seeks between segments, and `onProgress` lets the UI fill a
 * bar instead of showing a spinner for two minutes. It also means cancelling
 * costs at most one segment of wasted work.
 */
export async function synthesizePodcastCommand(
  script: PodcastScript,
  options: {
    voiceId: string;
    rate?: number;
    signal?: AbortSignal;
    onProgress?(done: number, total: number): void;
  },
): Promise<CommandResult<SpokenSegment[]>> {
  if (!script.segments.length) return fail('invalid_input', 'the script is empty');
  if (!options.voiceId) return fail('invalid_input', 'choose a voice first');

  const spoken: SpokenSegment[] = [];
  try {
    for (const [index, segment] of script.segments.entries()) {
      if (options.signal?.aborted) return fail('not_supported', 'cancelled');
      const result = await tts.synthesize(
        { text: segment.text, voiceId: options.voiceId, rate: options.rate },
        options.signal,
      );
      spoken.push({ audio: result.audio, durationMs: result.durationMs });
      options.onProgress?.(index + 1, script.segments.length);
    }
    return ok(spoken);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return fail('not_supported', 'cancelled');
    }
    return fail('storage_failed', message(error));
  }
}

/** Save the episode as one file. See `src/lib/podcast/wav.ts` for why joining
 * the segments is safe, and why it checks rather than assumes. */
export async function exportPodcastAudioCommand(
  script: PodcastScript,
  segments: SpokenSegment[],
  destination?: string,
): Promise<CommandResult<string | undefined>> {
  if (!segments.length) return fail('invalid_input', 'nothing has been synthesised yet');

  const name = `${
    script.title
      .replaceAll(/[^\p{Letter}\p{Number}]+/gu, '-')
      .replaceAll(/^-|-$/g, '')
      .toLocaleLowerCase() || 'episode'
  }.wav`;
  const target =
    destination ??
    (await dialog.saveFile({
      defaultPath: name,
      filters: [{ name: 'WAV', extensions: ['wav'] }],
    }));
  if (!target) return fail('not_supported', 'export cancelled');

  try {
    const parts: Uint8Array[] = [];
    for (const segment of segments) {
      parts.push(new Uint8Array(await segment.audio.arrayBuffer()));
    }
    const result = await exporter.write({
      format: 'audio',
      destination: target,
      suggestedName: name,
      files: [
        { path: name, contents: new Blob([concatWav(parts)], { type: 'audio/wav' }) },
      ],
    });
    return result.ok
      ? ok(result.path)
      : fail('storage_failed', result.error ?? 'export failed');
  } catch (error) {
    return fail('storage_failed', message(error));
  }
}

/** Keep the script as a note section, for the student who would rather read it
 * than listen to it — or who wants to check what the voice is about to say. */
export async function savePodcastScriptToNoteCommand(
  noteId: string,
  script: PodcastScript,
): Promise<CommandResult<Note>> {
  const single = script.mode === 'narrator';
  const markdown = [
    `## ${script.title}`,
    '',
    ...script.segments.map((segment) =>
      single ? segment.text : `**${segment.speaker}** — ${segment.text}`,
    ),
  ].join('\n\n');

  return appendToNote(noteId, [
    { type: 'horizontalRule' },
    ...markdownToDoc(markdown).content,
  ]);
}
