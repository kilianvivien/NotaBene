/**
 * Phase G — study features.
 *
 * The three things that would lose the student's work or their trust if they
 * broke, and that no amount of clicking around would reliably catch:
 *
 *   1. a malformed mind map cannot reach a note, and a well-formed one always
 *      lays out — including the shapes a model actually emits, which are not
 *      always trees no matter what the prompt says;
 *   2. an Anki file imports as the cards the student reviewed, with the
 *      separators and note types Anki needs and nothing that would shift a
 *      column;
 *   3. joining audio segments produces an episode of the right length rather
 *      than one that plays at the wrong speed.
 *
 * The provider calls themselves are Phase E's tests; nothing here goes near a
 * network.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { memoryLibraryAdapter } from '@/lib/adapters/library/memoryLibraryAdapter';
import { createNoteCommand, saveFlashcardsToNoteCommand } from '@/lib/commands';
import { deckToAnkiTsv } from '@/lib/export/anki';
import { layoutMindMap, mindMapToSvg } from '@/lib/mindmap/layout';
import { svgDataUri, svgSize } from '@/lib/mindmap/svg';
import { concatWav, encodeWav, parseWav, wavDurationMs } from '@/lib/podcast/wav';
import { parseModelJson } from '@/lib/ai';
import { estimateSpokenMinutes } from '@/lib/ai/podcast';
import {
  AiFlashcardsResponseSchema,
  AiMindMapResponseSchema,
  AiPodcastResponseSchema,
  answerable,
  FlashcardDeckSchema,
  type FlashcardDeck,
  type MindMap,
} from '@/lib/schema';
import { flattenDoc } from '@/lib/notes/docText';

// ---------------------------------------------------------------------------
// Mind map
// ---------------------------------------------------------------------------

const MAP: MindMap = {
  title: 'Limits',
  nodes: [
    { id: 'root', label: 'Limits' },
    { id: 'def', label: 'Definition' },
    { id: 'eps', label: 'Epsilon delta' },
    { id: 'cont', label: 'Continuity' },
  ],
  edges: [
    { from: 'root', to: 'def' },
    { from: 'def', to: 'eps', label: 'formally' },
    { from: 'root', to: 'cont' },
  ],
};

describe('a malformed mind map never reaches a note', () => {
  const garbage = [
    '',
    'Here is your map!',
    '{"title": "T", "nodes": []}',
    // The one that matters most: an edge to a node the model never listed
    // would draw a branch to nowhere.
    '{"title": "T", "nodes": [{"id": "a", "label": "A"}], "edges": [{"from": "a", "to": "ghost"}]}',
    '{"title": "T", "nodes": [{"id": "a"}]}',
    '{"title": "T", "nodes": [{"id": "", "label": "A"}]}',
    '<!doctype html><title>402 Payment Required</title>',
  ];

  for (const payload of garbage) {
    it(`rejects ${JSON.stringify(payload.slice(0, 46))}`, () => {
      expect(() => parseModelJson(AiMindMapResponseSchema, payload)).toThrow();
    });
  }

  it('accepts a well-formed map, edge labels and all', () => {
    const parsed = parseModelJson(AiMindMapResponseSchema, JSON.stringify(MAP));
    expect(parsed.nodes).toHaveLength(4);
    expect(parsed.edges[1]?.label).toBe('formally');
  });
});

describe('mind map layout', () => {
  it('roots the tree at the node nothing points to, and ranks by depth', () => {
    const layout = layoutMindMap(MAP);
    const byId = new Map(layout.nodes.map((node) => [node.id, node]));
    expect(byId.get('root')?.depth).toBe(0);
    expect(byId.get('def')?.depth).toBe(1);
    expect(byId.get('eps')?.depth).toBe(2);
    // The root sits at the origin; a child cannot.
    expect(byId.get('root')?.x).toBe(0);
    expect(byId.get('def')?.x === 0 && byId.get('def')?.y === 0).toBe(false);
  });

  it('draws every node exactly once, whatever the model sent', () => {
    const layout = layoutMindMap(MAP);
    expect(layout.nodes).toHaveLength(MAP.nodes.length);
    expect(new Set(layout.nodes.map((node) => node.id)).size).toBe(MAP.nodes.length);
  });

  /**
   * The schema guarantees edges point at real nodes; it does not guarantee a
   * tree. Both of these pass validation and would hang or drop content in a
   * layout that trusted the prompt.
   */
  it('survives a cycle', () => {
    const cyclic: MindMap = {
      title: 'Cycle',
      nodes: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
        { id: 'c', label: 'C' },
      ],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
        { from: 'c', to: 'a' },
      ],
    };
    const layout = layoutMindMap(cyclic);
    expect(layout.nodes).toHaveLength(3);
    // Three nodes, and no node claimed twice: the back edge is dropped.
    expect(layout.edges).toHaveLength(2);
  });

  it('draws a node with two parents once, and an orphan at all', () => {
    const messy: MindMap = {
      title: 'Messy',
      nodes: [
        { id: 'root', label: 'Root' },
        { id: 'x', label: 'X' },
        { id: 'y', label: 'Y' },
        { id: 'shared', label: 'Shared' },
        { id: 'lonely', label: 'Lonely' },
      ],
      edges: [
        { from: 'root', to: 'x' },
        { from: 'root', to: 'y' },
        { from: 'x', to: 'shared' },
        { from: 'y', to: 'shared' },
      ],
    };
    const layout = layoutMindMap(messy);
    expect(layout.nodes).toHaveLength(5);
    expect(layout.nodes.filter((node) => node.id === 'shared')).toHaveLength(1);
    // An unreachable node hangs off the root rather than disappearing.
    const lonely = layout.nodes.find((node) => node.id === 'lonely');
    expect(lonely?.depth).toBe(1);
  });

  it('wraps a long label instead of letting it run out of its box', () => {
    const layout = layoutMindMap({
      title: 'T',
      nodes: [
        { id: 'a', label: 'The fundamental theorem of calculus and its two parts' },
      ],
      edges: [],
    });
    expect(layout.nodes[0]!.lines.length).toBeGreaterThan(1);
  });
});

describe('the rendered SVG', () => {
  const svg = mindMapToSvg(MAP);

  it('is a standalone document with a viewBox', () => {
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).toContain('viewBox=');
    expect(svg.endsWith('</svg>')).toBe(true);
  });

  it('carries every label, so an export is not a picture of nothing', () => {
    for (const node of MAP.nodes) expect(svg).toContain(node.label);
  });

  /** The string is inlined in exported HTML. A label containing `<` that was
   * not escaped would close the text element and eat the rest of the map. */
  it('escapes markup in a label', () => {
    const hostile = mindMapToSvg({
      title: 'T',
      nodes: [{ id: 'a', label: 'a < b & "c"' }],
      edges: [],
    });
    expect(hostile).toContain('&lt;');
    expect(hostile).toContain('&amp;');
    expect(hostile).not.toContain('a < b');
  });
});

describe('a mind map in a note', () => {
  it('puts its labels in the searchable text but not its SVG', () => {
    const text = flattenDoc({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Lecture' }] },
        { type: 'mindMap', attrs: { data: MAP, svg: mindMapToSvg(MAP) } },
      ],
    });
    expect(text).toContain('Epsilon delta');
    expect(text).not.toContain('<svg');
    expect(text).not.toContain('viewBox');
  });

  it('ignores a map attribute that is not one', () => {
    for (const data of [null, 'nope', { nodes: 'no' }, { nodes: [1, 2] }]) {
      expect(() =>
        flattenDoc({ type: 'doc', content: [{ type: 'mindMap', attrs: { data } }] }),
      ).not.toThrow();
    }
  });
});

/**
 * The viewer's zoom is a multiple of the map's intrinsic size, so reading that
 * size back out of the string is what makes "100%" mean 1:1 rather than
 * whatever the browser guessed.
 */
describe('reading a rendered map back', () => {
  it('takes its size from the viewBox, which is centred on the root', () => {
    const svg = mindMapToSvg({
      title: 'T',
      nodes: [
        { id: 'a', label: 'Root' },
        { id: 'b', label: 'Child' },
      ],
      edges: [{ from: 'a', to: 'b' }],
    });
    const { width, height } = svgSize(svg);
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
    expect(svg).toContain(`viewBox="${-width / 2} ${-height / 2} ${width} ${height}"`);
  });

  it('falls back rather than returning a zero-sized map', () => {
    expect(svgSize('<svg xmlns="http://www.w3.org/2000/svg"></svg>').width).toBeGreaterThan(
      0,
    );
  });

  /** Every colour in the render is a `#` literal, which a data URI would read
   * as the start of a fragment if it were not escaped. */
  it('escapes the colour literals when building a data URI', () => {
    expect(svgDataUri('<svg fill="#fbfaf8"/>')).not.toContain('#');
  });
});

// ---------------------------------------------------------------------------
// Flashcards
// ---------------------------------------------------------------------------

describe('flashcards from a model', () => {
  it('rejects a deck with no cards or an unusable one', () => {
    for (const payload of [
      '{"title": "T", "cards": []}',
      '{"title": "T", "cards": [{"front": "", "back": "b"}]}',
      '{"cards": [{"front": "a", "back": "b"}]}',
    ]) {
      expect(() => parseModelJson(AiFlashcardsResponseSchema, payload)).toThrow();
    }
  });

  it('accepts cards without ids — the app mints those', () => {
    const parsed = parseModelJson(
      AiFlashcardsResponseSchema,
      '{"title": "Limits", "cards": [{"front": "What is a limit?", "back": "A value approached."}]}',
    );
    expect(parsed.cards[0]).toMatchObject({ kind: 'basic', tags: [] });
  });

  /** The regression that made a whole generation fail: a cloze card's `back` is
   * Anki's Extra field, and a model is right to leave it out. */
  it('accepts a cloze card with no back', () => {
    const parsed = parseModelJson(
      AiFlashcardsResponseSchema,
      '{"title": "T", "cards": [{"kind": "cloze", "front": "Water boils at {{c1::100°C}}"}]}',
    );
    expect(parsed.cards[0]?.back).toBe('');
    expect(answerable(parsed.cards[0]!)).toBe(true);
  });

  /** The wire shape is permissive so one fumbled card does not cost the deck;
   * the app-facing contract is not, and is what the dialog is handed. */
  it('still refuses a card with neither a deletion nor a back', () => {
    const parsed = parseModelJson(
      AiFlashcardsResponseSchema,
      '{"title": "T", "cards": [{"front": "a"}]}',
    );
    expect(answerable(parsed.cards[0]!)).toBe(false);
    expect(() =>
      FlashcardDeckSchema.parse({
        title: 'T',
        cards: [{ id: '1', kind: 'basic', front: 'a', back: '', tags: [] }],
      }),
    ).toThrow();
  });
});

const DECK: FlashcardDeck = {
  title: 'Limits',
  cards: [
    {
      id: '1',
      kind: 'basic',
      front: 'What is a limit?',
      back: 'A value approached.',
      tags: [],
    },
    {
      id: '2',
      kind: 'basic',
      front: 'Define continuity',
      back: 'f is continuous at a\nwhen lim f(x) = f(a)',
      hint: 'think of the graph',
      tags: ['calculus'],
    },
    {
      id: '3',
      kind: 'cloze',
      front: 'A function is {{c1::continuous}} at a point when…',
      back: 'A function is continuous at a point when…',
      tags: [],
    },
  ],
};

describe('the Anki file', () => {
  const tsv = deckToAnkiTsv(DECK, { deckPrefix: 'Analysis I' });
  const lines = tsv.trimEnd().split('\n');
  const rows = lines.filter((line) => !line.startsWith('#'));

  it('declares the separator, the HTML flag and the deck path', () => {
    expect(lines[0]).toBe('#separator:tab');
    expect(lines).toContain('#html:true');
    expect(lines).toContain('#deck:Analysis I::Limits');
  });

  it('names both built-in note types, each before the rows it governs', () => {
    expect(lines).toContain('#notetype:Basic');
    expect(lines).toContain('#notetype:Cloze');
    expect(lines.indexOf('#notetype:Cloze')).toBeGreaterThan(
      lines.indexOf('#notetype:Basic'),
    );
  });

  it('writes one row per card, with exactly three columns', () => {
    expect(rows).toHaveLength(DECK.cards.length);
    for (const row of rows) expect(row.split('\t')).toHaveLength(3);
  });

  it('turns a line break into a <br> rather than into a second row', () => {
    const continuity = rows.find((row) => row.startsWith('Define continuity'));
    expect(continuity).toContain('<br>');
    expect(continuity).toContain('<i>think of the graph</i>');
  });

  it('keeps the cloze deletion intact — it is the card', () => {
    expect(tsv).toContain('{{c1::continuous}}');
  });

  it('tags every card so a re-import is easy to find', () => {
    for (const row of rows) expect(row.split('\t')[2]).toContain('notabene');
  });

  /** A tab inside a field would end the column early and shift the tags into
   * the answer; a `<` would be read as markup once `#html:true` is set. */
  it('neutralises a tab and escapes markup in a field', () => {
    const hostile = deckToAnkiTsv({
      title: 'Hostile',
      cards: [
        { id: '1', kind: 'basic', front: 'a\tb', back: 'x < y & z', tags: ['two words'] },
      ],
    });
    const row = hostile.trimEnd().split('\n').at(-1)!;
    expect(row.split('\t')).toHaveLength(3);
    expect(row).toContain('&lt;');
    expect(row).toContain('two-words');
  });

  it('does not let a title nest the deck somewhere unasked', () => {
    const nested = deckToAnkiTsv({
      title: 'Week 1::secret',
      cards: [{ id: '1', kind: 'basic', front: 'a', back: 'b', tags: [] }],
    });
    expect(nested).toContain('#deck:Week 1:secret');
  });
});

/**
 * The deck writer emits Markdown in the app's own dialect, which the editor
 * then has to parse back. A callout marker that drifted would turn every answer
 * into a visible line of `> [!TOGGLE Answer]` instead of something to uncover.
 */
describe('a deck saved into a note', () => {
  beforeEach(() => {
    memoryLibraryAdapter.reset();
  });

  it('appends a self-test section with the answers behind toggles', async () => {
    const created = await createNoteCommand({
      title: 'Lecture',
      doc: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Body' }] }],
      },
    });
    if (!created.ok) throw new Error(created.message);

    const saved = await saveFlashcardsToNoteCommand(created.value.id, DECK);
    if (!saved.ok) throw new Error(saved.message);

    const types = saved.value.doc.content.map((node) => node.type);
    expect(types[0]).toBe('paragraph'); // the original body is still first
    expect(types).toContain('horizontalRule');
    expect(types.filter((type) => type === 'toggle')).toHaveLength(DECK.cards.length);

    // The answer is inside the toggle, and the question is not.
    const toggle = saved.value.doc.content.find((node) => node.type === 'toggle');
    expect(flattenDoc({ type: 'doc', content: [toggle!] })).toContain(
      'A value approached.',
    );
    expect(saved.value.plainText).toContain('What is a limit?');
  });

  it('refuses an empty deck rather than appending a lone rule', async () => {
    const created = await createNoteCommand({ title: 'Lecture' });
    if (!created.ok) throw new Error(created.message);
    const saved = await saveFlashcardsToNoteCommand(created.value.id, {
      title: 'Empty',
      cards: [],
    });
    expect(saved.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Podcast audio
// ---------------------------------------------------------------------------

/** A WAV of `ms` milliseconds of silence, in the format the TTS bridge writes.
 * `extra` inserts a `LIST` chunk ahead of the audio, which is what macOS
 * actually produces and what a naive reader would take for samples. */
function silence(ms: number, options: { list?: boolean } = {}): Uint8Array {
  const sampleRate = 22_050;
  const frames = Math.round((ms / 1000) * sampleRate);
  const pcm = new Uint8Array(frames * 2);
  const wav = encodeWav({
    format: { sampleRate, channels: 1, bitsPerSample: 16 },
    samples: pcm,
  });
  if (!options.list) return wav;

  const list = new Uint8Array(12);
  new DataView(list.buffer).setUint32(4, 4, true);
  list.set([0x4c, 0x49, 0x53, 0x54], 0); // "LIST"
  list.set([0x49, 0x4e, 0x46, 0x4f], 8); // "INFO"

  const out = new Uint8Array(wav.byteLength + list.byteLength);
  out.set(wav.subarray(0, 36), 0);
  out.set(list, 36);
  out.set(wav.subarray(36), 36 + list.byteLength);
  return out;
}

describe('WAV handling', () => {
  it('round-trips a file through encode and parse', () => {
    const audio = parseWav(silence(1000));
    expect(audio.format).toEqual({ sampleRate: 22_050, channels: 1, bitsPerSample: 16 });
    expect(wavDurationMs(audio)).toBe(1000);
  });

  it('walks past a metadata chunk instead of reading it as audio', () => {
    expect(wavDurationMs(parseWav(silence(500, { list: true })))).toBe(500);
  });

  it('refuses something that is not a WAV', () => {
    expect(() => parseWav(new TextEncoder().encode('not audio at all'))).toThrow();
  });

  it('joins segments into one episode of the summed length, plus the gaps', () => {
    const audio = parseWav(concatWav([silence(1000), silence(500), silence(500)], 200));
    // Two gaps between three segments.
    expect(wavDurationMs(audio)).toBe(2000 + 400);
    expect(audio.format.sampleRate).toBe(22_050);
  });

  /** The failure this exists to prevent is silent: mismatched rates concatenate
   * happily and produce an episode that plays back at the wrong speed. */
  it('refuses to join segments that do not share a format', () => {
    const other = encodeWav({
      format: { sampleRate: 44_100, channels: 1, bitsPerSample: 16 },
      samples: new Uint8Array(200),
    });
    expect(() => concatWav([silence(100), other])).toThrow(/one format/);
  });

  it('refuses to join nothing', () => {
    expect(() => concatWav([])).toThrow();
  });
});

describe('the podcast script', () => {
  it('rejects a script with no segments or an empty one', () => {
    for (const payload of [
      '{"title": "T", "segments": []}',
      '{"title": "T", "segments": [{"text": ""}]}',
      '{"segments": [{"text": "hello"}]}',
    ]) {
      expect(() => parseModelJson(AiPodcastResponseSchema, payload)).toThrow();
    }
  });

  it('defaults an unlabelled speaker to the narrator', () => {
    const parsed = parseModelJson(
      AiPodcastResponseSchema,
      '{"title": "T", "segments": [{"text": "Welcome back."}]}',
    );
    expect(parsed.segments[0]?.speaker).toBe('narrator');
    expect(parsed.mode).toBe('narrator');
  });

  it('estimates a length from the word count, never below a minute', () => {
    expect(
      estimateSpokenMinutes({
        title: 'T',
        mode: 'narrator',
        segments: [{ speaker: 'narrator', text: 'one two three' }],
      }),
    ).toBe(1);
    expect(
      estimateSpokenMinutes({
        title: 'T',
        mode: 'narrator',
        segments: [{ speaker: 'narrator', text: 'word '.repeat(450).trim() }],
      }),
    ).toBe(3);
  });
});
