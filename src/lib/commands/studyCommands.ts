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
import {
  dialog,
  exporter,
  library,
  ttsRegistry,
  type TtsEngine,
  type TtsEngineId,
  type TtsSegmentResult,
  type TtsVoice,
} from '@/lib/adapters';
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
import { isTauri } from '@/lib/platform/runtime';
import {
  MindMapSchema,
  type DocNode,
  type FlashcardDeck,
  type MindMap,
  type Note,
  type PodcastScript,
} from '@/lib/schema';
import { useEditorStore } from '@/lib/state/editorStore';
import {
  normalizeSpeechText,
  normalizeVoxtralSpeechText,
} from '@/lib/tts/normalizeSpeechText';
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
      contents = await (
        await import('@/lib/export/pdf')
      ).mindMapToPdf(map.svg, map.title);
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
  /** Applied by the player only; exported PCM remains at natural speed. */
  playbackRate?: number;
}

/**
 * Put voices for the app's language first without hiding the others.
 *
 * UI language is a useful default, not a speech-language setting: a student
 * using NotaBene in French may still be reading an English article. A stable
 * partition keeps the relevant macOS voices near the top of its long list
 * while preserving every explicit language choice.
 */
export function prioritizeVoicesForLocale(
  voices: TtsVoice[],
  locale: string,
): TtsVoice[] {
  const language = locale.slice(0, 2).toLowerCase();
  const matches = voices.filter((voice) =>
    voice.locale.toLowerCase().startsWith(language),
  );
  const others = voices.filter(
    (voice) => !voice.locale.toLowerCase().startsWith(language),
  );
  return [...matches, ...others];
}

export async function listPodcastVoicesCommand(
  locale: string,
  engineId: TtsEngineId = 'system',
): Promise<CommandResult<TtsVoice[]>> {
  try {
    const engine = ttsRegistry.get(engineId);
    if (!(await engine.isAvailable())) {
      return fail('not_supported', 'text-to-speech is not available on this system');
    }
    const voices = await engine.listVoices();
    return ok(prioritizeVoicesForLocale(voices, locale));
  } catch (error) {
    return fail('not_supported', message(error));
  }
}

async function resolveSpeechEngine(engineId: TtsEngineId): Promise<TtsEngine> {
  return ttsRegistry.resolveConfiguredEngine(engineId);
}

async function systemFallback(
  locale = 'en',
): Promise<{ engine: TtsEngine; voiceId: string }> {
  const engine = await ttsRegistry.resolveConfiguredEngine('system');
  const voices = await engine.listVoices();
  const voice =
    voices.find((candidate) =>
      candidate.locale.toLowerCase().startsWith(locale.slice(0, 2).toLowerCase()),
    ) ?? voices[0];
  if (!voice) throw new Error('text-to-speech is not available on this system');
  return { engine, voiceId: voice.id };
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
    engineId?: TtsEngineId;
    rate?: number;
    fallbackToSystem?: boolean;
    locale?: string;
    signal?: AbortSignal;
    onProgress?(done: number, total: number): void;
    onSegment?(segment: SpokenSegment, index: number, total: number): void;
  },
): Promise<CommandResult<SpokenSegment[]>> {
  if (!script.segments.length) return fail('invalid_input', 'the script is empty');
  if (!options.voiceId) return fail('invalid_input', 'choose a voice first');

  const spoken: SpokenSegment[] = [];
  try {
    let engine: TtsEngine;
    let voiceId = options.voiceId;
    try {
      engine = await resolveSpeechEngine(options.engineId ?? 'system');
    } catch (error) {
      if ((options.engineId ?? 'system') === 'system' || !options.fallbackToSystem) {
        throw error;
      }
      ({ engine, voiceId } = await systemFallback(options.locale));
    }
    let playbackRate =
      (await engine.capabilities()).supportsRate === 'playback'
        ? options.rate
        : undefined;
    const chunkedSegments = script.segments.map((segment) => ({
      segment,
      chunks: preparedSpeechChunks(
        segment.text,
        options.locale,
        options.engineId ?? 'system',
      ),
    }));
    const totalChunks = chunkedSegments.reduce(
      (total, entry) => total + entry.chunks.length,
      0,
    );
    let completedChunks = 0;
    for (const { chunks } of chunkedSegments) {
      if (options.signal?.aborted) return fail('not_supported', 'cancelled');
      const parts: Uint8Array[] = [];
      let durationMs = 0;
      for (const text of chunks) {
        const request = { text, voiceId, rate: options.rate };
        let result;
        try {
          result = await synthesizeSpeechChunk(engine, request, options.signal);
        } catch (error) {
          // A fallback is safe only while no audio has been generated. Switching
          // engines later would change voices inside the same episode.
          if (
            completedChunks === 0 &&
            engine.id !== 'system' &&
            options.fallbackToSystem
          ) {
            ({ engine, voiceId } = await systemFallback(options.locale));
            playbackRate =
              (await engine.capabilities()).supportsRate === 'playback'
                ? options.rate
                : undefined;
            result = await synthesizeSpeechChunk(
              engine,
              { ...request, voiceId },
              options.signal,
            );
          } else {
            throw error;
          }
        }
        parts.push(new Uint8Array(await result.audio.arrayBuffer()));
        durationMs += result.durationMs;
        completedChunks += 1;
        options.onProgress?.(completedChunks, totalChunks);
      }
      const spokenSegment = {
        audio: new Blob([concatWav(parts, 0)], { type: 'audio/wav' }),
        durationMs,
        playbackRate,
      };
      spoken.push(spokenSegment);
      options.onSegment?.(spokenSegment, spoken.length - 1, chunkedSegments.length);
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
 * second. Splitting on sentence ends and grouping to each engine's budget means
 * the first chunk is short enough to arrive quickly and the rest are long
 * enough not to sound chopped.
 */
const DEFAULT_MAX_CHARS = 320;
const VOXTRAL_MAX_CHARS = 180;

function terminalPunctuation(text: string): string {
  if (/[.!?…]["')\]]?$/.test(text)) return text;
  if (/[,;:]$/.test(text)) return `${text.slice(0, -1)}.`;
  return `${text}.`;
}

function splitOversizedSpeech(text: string, maxChars: number): string[] {
  const parts: string[] = [];
  let remaining = text.trim();
  while (remaining.length > maxChars) {
    const window = remaining.slice(0, maxChars + 1);
    const minimumBreak = Math.floor(maxChars * 0.45);
    let splitAt = -1;
    for (const match of window.matchAll(/[,;:]\s+/g)) {
      const candidate = match.index + match[0].trimEnd().length;
      if (candidate >= minimumBreak) splitAt = candidate;
    }
    if (splitAt < minimumBreak) {
      const whitespace = window.lastIndexOf(' ');
      if (whitespace >= minimumBreak) splitAt = whitespace;
    }
    if (splitAt < 1) splitAt = maxChars;
    parts.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) parts.push(remaining);
  return parts;
}

export function speechChunks(
  text: string,
  options: { engineId?: TtsEngineId; maxChars?: number } = {},
): string[] {
  const voxtral = options.engineId === 'voxtral-local';
  if (!voxtral) {
    const chunks: string[] = [];
    for (const paragraph of text.split(/\n{2,}/)) {
      const trimmed = paragraph.trim();
      if (!trimmed) continue;
      const sentences = trimmed.match(/[^.!?…]+[.!?…]*\s*/g) ?? [trimmed];
      let current = '';
      for (const sentence of sentences) {
        if (current && current.length + sentence.length > DEFAULT_MAX_CHARS) {
          chunks.push(current.trim());
          current = '';
        }
        current += sentence;
        while (current.length > DEFAULT_MAX_CHARS * 2) {
          chunks.push(current.slice(0, DEFAULT_MAX_CHARS * 2).trim());
          current = current.slice(DEFAULT_MAX_CHARS * 2);
        }
      }
      if (current.trim()) chunks.push(current.trim());
    }
    return chunks;
  }

  const maxChars = options.maxChars ?? VOXTRAL_MAX_CHARS;
  const contentLimit = maxChars - 1;
  const chunks: string[] = [];

  for (const paragraph of text.split(/\n{2,}/)) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;

    // Keep the terminator: `say` reads "Stop." and "Stop" with different
    // intonation, and the difference is audible across a whole note.
    const sentences = trimmed.match(/[^.!?…]+[.!?…]*\s*/g) ?? [trimmed];
    let current = '';
    for (const sentence of sentences) {
      for (const unit of splitOversizedSpeech(sentence.trim(), contentLimit)) {
        const joined = current ? `${current} ${unit}` : unit;
        if (current && joined.length > contentLimit) {
          chunks.push(terminalPunctuation(current));
          current = unit;
        } else {
          current = joined;
        }
      }
    }
    if (current) chunks.push(terminalPunctuation(current));
  }

  return chunks;
}

function preparedSpeechChunks(
  text: string,
  locale: string | undefined,
  engineId: TtsEngineId,
): string[] {
  const normalized =
    engineId === 'voxtral-local'
      ? normalizeVoxtralSpeechText(text, locale)
      : normalizeSpeechText(text, locale);
  return speechChunks(normalized, { engineId });
}

export function isLikelyIncompleteVoxtralAudio(
  text: string,
  durationMs: number,
): boolean {
  const words = text.match(/\p{L}[\p{L}\p{M}'’-]*/gu)?.length ?? 0;
  // 545 words/min is intentionally conservative: this catches a clearly
  // truncated result without rejecting genuinely fast speech or abbreviations.
  return words >= 8 && durationMs < words * 110;
}

async function synthesizeSpeechChunk(
  engine: TtsEngine,
  request: { text: string; voiceId: string; rate?: number },
  signal?: AbortSignal,
): Promise<TtsSegmentResult> {
  const result = await engine.synthesize(request, signal);
  if (
    engine.id !== 'voxtral-local' ||
    !isLikelyIncompleteVoxtralAudio(request.text, result.durationMs)
  ) {
    return result;
  }

  const recoveryChunks = speechChunks(request.text, {
    engineId: 'voxtral-local',
    maxChars: 90,
  });
  if (recoveryChunks.length < 2) {
    throw new Error(
      'TTS_GENERATION_FAILED: Voxtral stopped before reading the complete speech chunk.',
    );
  }

  const parts: Uint8Array[] = [];
  let durationMs = 0;
  for (const text of recoveryChunks) {
    if (signal?.aborted) throw new DOMException('cancelled', 'AbortError');
    const recovered = await engine.synthesize({ ...request, text }, signal);
    if (isLikelyIncompleteVoxtralAudio(text, recovered.durationMs)) {
      throw new Error(
        'TTS_GENERATION_FAILED: Voxtral stopped before reading the complete speech chunk.',
      );
    }
    parts.push(new Uint8Array(await recovered.audio.arrayBuffer()));
    durationMs += recovered.durationMs;
  }
  return {
    audio: new Blob([concatWav(parts, 0)], { type: 'audio/wav' }),
    durationMs,
    sampleRateHz: result.sampleRateHz,
    channels: result.channels,
  };
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
 * Hosted engines receive only these normalized chunks, and only when the user
 * explicitly selected one. Fallback always points toward the Mac, never from
 * a local engine to a cloud service.
 */
export async function readAloudCommand(
  text: string,
  options: {
    voiceId: string;
    engineId?: TtsEngineId;
    rate?: number;
    fallbackToSystem?: boolean;
    locale?: string;
    signal?: AbortSignal;
    onSynthesisStart?(): void;
    onChunk?(chunk: SpokenSegment, index: number, total: number): void;
  },
): Promise<CommandResult<number>> {
  const chunks = preparedSpeechChunks(
    text,
    options.locale,
    options.engineId ?? 'system',
  );
  if (!chunks.length) return fail('invalid_input', 'there is nothing to read');
  if (!options.voiceId) return fail('invalid_input', 'choose a voice first');

  try {
    let engine: TtsEngine;
    let voiceId = options.voiceId;
    try {
      engine = await resolveSpeechEngine(options.engineId ?? 'system');
    } catch (error) {
      if ((options.engineId ?? 'system') === 'system' || !options.fallbackToSystem) {
        throw error;
      }
      ({ engine, voiceId } = await systemFallback(options.locale));
    }
    let playbackRate =
      (await engine.capabilities()).supportsRate === 'playback'
        ? options.rate
        : undefined;
    for (const [index, chunk] of chunks.entries()) {
      if (options.signal?.aborted) return ok(index);
      let result;
      try {
        result = await synthesizeSpeechChunk(
          engine,
          { text: chunk, voiceId, rate: options.rate },
          options.signal,
        );
      } catch (error) {
        // Only before the first segment: swapping engines mid-reading would
        // change voice partway through a note.
        if (index === 0 && engine.id !== 'system' && options.fallbackToSystem) {
          ({ engine, voiceId } = await systemFallback(options.locale));
          playbackRate =
            (await engine.capabilities()).supportsRate === 'playback'
              ? options.rate
              : undefined;
          result = await synthesizeSpeechChunk(
            engine,
            { text: chunk, voiceId, rate: options.rate },
            options.signal,
          );
        } else {
          throw error;
        }
      }
      if (options.signal?.aborted) return ok(index);
      options.onChunk?.(
        { audio: result.audio, durationMs: result.durationMs, playbackRate },
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
  const { createEncoder, createMp3Encoder } = await import('wasm-media-encoders');
  // The convenience helper embeds the WASM as a data URL and asks `fetch()` to
  // load it. WKWebView reports only "Load failed" for that fetch under the
  // desktop CSP. Give Tauri a normal bundled asset URL instead; the browser
  // and test builds keep the inline path.
  const encoder = isTauri
    ? await createEncoder(
        'audio/mpeg',
        (await import('wasm-media-encoders/wasm/mp3?url')).default,
      )
    : await createMp3Encoder();
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
          view.getInt16(((start + frame) * channels.length + channel) * 2, true) / 32768;
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
      files: [{ path: name, contents: audio }],
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
