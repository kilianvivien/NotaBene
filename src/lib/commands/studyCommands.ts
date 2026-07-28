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
import { mindMapOutline } from '@/lib/mindmap/edit';
import { concatWav, parseWav } from '@/lib/podcast/wav';
import {
  MindMapSchema,
  type DocNode,
  type FlashcardDeck,
  type MindMap,
  type Note,
  type PodcastScript,
} from '@/lib/schema';
import { useEditorStore } from '@/lib/state/editorStore';
import { language, providerFor } from './aiCommands';
import { updateNoteCommand } from './noteCommands';
import { createNoteCommand } from './noteCommands';
import { addAttachmentCommand } from './assetCommands';
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

/** A title as a filename: no diacritics, no separators, nothing a shell or a
 * Finder column will argue with. */
function slug(title: string, fallback: string): string {
  return (
    title
      .normalize('NFKD')
      .replaceAll(/\p{Diacritic}/gu, '')
      .replaceAll(/[^\p{Letter}\p{Number}]+/gu, '-')
      .replaceAll(/^-|-$/g, '')
      .toLocaleLowerCase() || fallback
  );
}

/**
 * Save a map on its own, as a picture.
 *
 * SVG is the map itself — the exact string the note holds, so it reopens in
 * Illustrator or a browser at any size with the text still text. PDF is the
 * one to hand in or print. Both are written from the stored `svg` and never
 * re-laid-out, for the reason the block comment in `MindMap.tsx` gives: a map
 * that redrew at export time would not be the map the student looked at.
 */
export async function exportMindMapCommand(
  map: { svg: string; title: string; data?: MindMap },
  format: 'svg' | 'pdf' | 'png' | 'markdown',
  destination?: string,
): Promise<CommandResult<string | undefined>> {
  if (!map.svg.trim()) return fail('invalid_input', 'this map has not been rendered');

  const extension = format === 'markdown' ? 'md' : format;
  const name = `${slug(map.title, 'mind-map')}.${extension}`;
  const target =
    destination ??
    (await dialog.saveFile({
      defaultPath: name,
      filters: [{ name: format.toUpperCase(), extensions: [extension] }],
    }));
  if (!target) return fail('not_supported', 'export cancelled');

  try {
    // pdfmake and its font file are megabytes, and `exportCommands.ts` already
    // keeps them out of the startup chunk for the same reason. A static import
    // here would put them back and undo that from the other side.
    let contents: Blob;
    if (format === 'svg') {
      contents = new Blob([map.svg], { type: 'image/svg+xml;charset=utf-8' });
    } else if (format === 'pdf') {
      contents = await (await import('@/lib/export/pdf')).mindMapToPdf(
        map.svg,
        map.title,
      );
    } else if (format === 'markdown') {
      const parsed = MindMapSchema.safeParse(map.data);
      if (!parsed.success) return fail('invalid_input', 'this map has no editable tree');
      contents = new Blob([mindMapOutline(parsed.data)], {
        type: 'text/markdown;charset=utf-8',
      });
    } else {
      contents = await svgToPng(map.svg);
    }

    const result = await exporter.write({
      format,
      destination: target,
      suggestedName: name,
      files: [{ path: name, contents }],
    });
    return result.ok
      ? ok(result.path)
      : fail('storage_failed', result.error ?? 'export failed');
  } catch (error) {
    return fail('storage_failed', message(error));
  }
}

async function svgToPng(svg: string): Promise<Blob> {
  const source = URL.createObjectURL(
    new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }),
  );
  try {
    const image = new Image();
    image.src = source;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, image.naturalWidth);
    canvas.height = Math.max(1, image.naturalHeight);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('PNG export is not available');
    context.drawImage(image, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/png'),
    );
    if (!blob) throw new Error('PNG export failed');
    return blob;
  } finally {
    URL.revokeObjectURL(source);
  }
}

export async function saveMindMapAsNoteCommand(
  map: { svg: string; title: string; data: MindMap },
  courseId: string | null = null,
): Promise<CommandResult<Note>> {
  const parsed = MindMapSchema.safeParse(map.data);
  if (!parsed.success) return fail('invalid_input', 'this map has no editable tree');
  return createNoteCommand({
    title: map.title,
    courseId,
    doc: {
      type: 'doc',
      content: [
        {
          type: 'mindMap',
          attrs: { data: parsed.data, svg: map.svg, title: map.title },
        },
        ...markdownToDoc(mindMapOutline(parsed.data)).content.slice(1),
      ],
    },
  });
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

/** Hide a cloze deletion, and show it. `{{c1::the term}}` reads as `[…]` on the
 * question side and as the term itself on the answer side — which is the whole
 * card, because a cloze card's answer is not in its `back` field. */
function cloze(text: string, reveal: boolean): string {
  return text.replaceAll(/\{\{c\d+::([^}|]*)(?:\|[^}]*)?\}\}/g, reveal ? '$1' : '[…]');
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
  const answerLabel = language().startsWith('fr') ? 'Réponse' : 'Answer';

  const markdown = [
    `## ${deck.title}`,
    '',
    ...deck.cards.flatMap((card) => {
      const front = cloze(card.front, false).replaceAll('\n', ' ');
      // A cloze card keeps its answer in the front; `back` is Anki's Extra and
      // is often empty, so the toggle shows the revealed sentence with the
      // aside under it rather than an empty box.
      const answer = [
        card.kind === 'cloze' ? cloze(card.front, true).replaceAll('\n', ' ') : '',
        card.back.replaceAll('\n', ' '),
      ]
        .filter(Boolean)
        .join(' — ');

      return [
        `**${front}**`,
        '',
        ...(card.hint ? [`*${card.hint.replaceAll('\n', ' ')}*`, ''] : []),
        `> [!TOGGLE ${answerLabel}]`,
        `> ${answer}`,
        '',
      ];
    }),
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

/**
 * Break prose into things a synthesiser should be handed one at a time.
 *
 * Not for prosody — `say` handles a paragraph fine — but for latency. A
 * fifteen-hundred-word note takes the better part of a minute to synthesise in
 * one call, and a student who pressed a play button expects sound in about a
 * second. Splitting on sentence ends and grouping up to `MAX_CHARS` means the
 * first chunk is short enough to arrive quickly and the rest are long enough
 * not to sound chopped.
 */
const MAX_CHARS = 320;

export function speechChunks(text: string): string[] {
  const chunks: string[] = [];

  for (const paragraph of text.split(/\n{2,}/)) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;

    // Keep the terminator: `say` reads "Stop." and "Stop" with different
    // intonation, and the difference is audible across a whole note.
    const sentences = trimmed.match(/[^.!?…]+[.!?…]*\s*/g) ?? [trimmed];
    let current = '';
    for (const sentence of sentences) {
      if (current && current.length + sentence.length > MAX_CHARS) {
        chunks.push(current.trim());
        current = '';
      }
      current += sentence;
      // A single sentence longer than the budget goes on its own rather than
      // being cut mid-clause.
      while (current.length > MAX_CHARS * 2) {
        chunks.push(current.slice(0, MAX_CHARS * 2).trim());
        current = current.slice(MAX_CHARS * 2);
      }
    }
    if (current.trim()) chunks.push(current.trim());
  }

  return chunks;
}

/**
 * Read text aloud, now.
 *
 * The difference from `synthesizePodcastCommand` is that this one hands each
 * chunk back the moment it exists instead of returning a finished set. Reading
 * a note is a thing you start and listen to; waiting for the whole note to be
 * synthesised first would put ten seconds of nothing between the button and the
 * first word, which is the whole reason this exists as its own path rather than
 * as "generate a one-line podcast script".
 *
 * No provider is involved. This is the note's own words, spoken by the Mac.
 */
export async function readAloudCommand(
  text: string,
  options: {
    voiceId: string;
    rate?: number;
    signal?: AbortSignal;
    onChunk(chunk: SpokenSegment, index: number, total: number): void;
  },
): Promise<CommandResult<number>> {
  const chunks = speechChunks(text);
  if (!chunks.length) return fail('invalid_input', 'there is nothing to read');
  if (!options.voiceId) return fail('invalid_input', 'choose a voice first');

  try {
    for (const [index, chunk] of chunks.entries()) {
      if (options.signal?.aborted) return ok(index);
      const result = await tts.synthesize(
        { text: chunk, voiceId: options.voiceId, rate: options.rate },
        options.signal,
      );
      if (options.signal?.aborted) return ok(index);
      options.onChunk(
        { audio: result.audio, durationMs: result.durationMs },
        index,
        chunks.length,
      );
    }
    return ok(chunks.length);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return ok(0);
    return fail('storage_failed', message(error));
  }
}

export async function encodePodcastMp3Bytes(
  segments: SpokenSegment[],
): Promise<Uint8Array<ArrayBuffer>> {
  const parts: Uint8Array[] = [];
  for (const segment of segments) {
    parts.push(new Uint8Array(await segment.audio.arrayBuffer()));
  }
  const joined = parseWav(concatWav(parts));
  if (joined.format.bitsPerSample !== 16) {
    throw new Error('MP3 export requires 16-bit PCM audio');
  }
  if (joined.format.channels !== 1 && joined.format.channels !== 2) {
    throw new Error('MP3 export requires mono or stereo audio');
  }

  // Lazy: the encoder is useful only after an entire episode has been spoken.
  // Keeping its inline WASM out of the startup chunk protects cold launch.
  const { createMp3Encoder } = await import('wasm-media-encoders');
  const encoder = await createMp3Encoder();
  encoder.configure({
    sampleRate: joined.format.sampleRate,
    channels: joined.format.channels,
    bitrate: 96,
  });

  const view = new DataView(
    joined.samples.buffer,
    joined.samples.byteOffset,
    joined.samples.byteLength,
  );
  const frames = joined.samples.byteLength / (2 * joined.format.channels);
  const output: Uint8Array<ArrayBuffer>[] = [];
  const keep = (bytes: Uint8Array) => {
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    output.push(copy);
  };
  const FRAME_CHUNK = 1152 * 16;
  for (let start = 0; start < frames; start += FRAME_CHUNK) {
    const count = Math.min(FRAME_CHUNK, frames - start);
    const channels = Array.from(
      { length: joined.format.channels },
      () => new Float32Array(count),
    );
    for (let frame = 0; frame < count; frame += 1) {
      for (let channel = 0; channel < channels.length; channel += 1) {
        channels[channel]![frame] =
          view.getInt16(((start + frame) * channels.length + channel) * 2, true) /
          32768;
      }
    }
    const encoded = encoder.encode(channels);
    if (encoded.length) keep(encoded);
  }
  const final = encoder.finalize();
  if (final.length) keep(final);
  const total = output.reduce((sum, chunk) => sum + chunk.length, 0);
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of output) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  return combined;
}

export async function encodePodcastMp3(segments: SpokenSegment[]): Promise<Blob> {
  return new Blob([await encodePodcastMp3Bytes(segments)], { type: 'audio/mpeg' });
}

/** Save the episode as one compact MP3 file. PCM segments are joined and
 * encoded locally; no audio or note text crosses the network. */
export async function exportPodcastAudioCommand(
  script: PodcastScript,
  segments: SpokenSegment[],
  destination?: string,
): Promise<CommandResult<string | undefined>> {
  if (!segments.length) return fail('invalid_input', 'nothing has been synthesised yet');

  const name = `${slug(script.title, 'episode')}.mp3`;
  const target =
    destination ??
    (await dialog.saveFile({
      defaultPath: name,
      filters: [{ name: 'MP3 audio', extensions: ['mp3'] }],
    }));
  if (!target) return fail('not_supported', 'export cancelled');

  try {
    const audio = await encodePodcastMp3(segments);
    const result = await exporter.write({
      format: 'audio',
      destination: target,
      suggestedName: name,
      files: [
        { path: name, contents: audio },
      ],
    });
    return result.ok
      ? ok(result.path)
      : fail('storage_failed', result.error ?? 'export failed');
  } catch (error) {
    return fail('storage_failed', message(error));
  }
}

/** Store the rendered episode beside the note through the ordinary
 * content-addressed attachment path. */
export async function attachPodcastAudioCommand(
  noteId: string,
  script: PodcastScript,
  segments: SpokenSegment[],
): Promise<CommandResult<string>> {
  if (!segments.length) return fail('invalid_input', 'nothing has been synthesised yet');
  try {
    const name = `${slug(script.title, 'episode')}.mp3`;
    const audio = await encodePodcastMp3(segments);
    const attached = await addAttachmentCommand(
      noteId,
      new File([audio], name, { type: 'audio/mpeg' }),
    );
    return attached.ok
      ? ok(attached.value.id)
      : fail(attached.code, attached.message, attached.details);
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
