import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Slice } from '@tiptap/pm/model';
import { editorExtensions } from '.';
import {
  formatOffset,
  lectureAnchorsPluginKey,
  parseAudioAnchor,
  refreshLectureAnchors,
  type LectureAnchorsOptions,
} from './LectureAnchors';

let editor: Editor | undefined;
let recording: ReturnType<LectureAnchorsOptions['active']> = null;
let available = new Set<string>();

afterEach(() => {
  editor?.destroy();
  editor = undefined;
  recording = null;
  available = new Set();
  vi.useRealTimers();
});

function open(content: string | object, play = vi.fn()): Editor {
  editor = new Editor({
    extensions: editorExtensions('Write…', undefined, undefined, undefined, {
      active: () => recording,
      noteId: () => 'note-1',
      available: () => available,
      play,
      label: (ms) => `Play from ${formatOffset(ms)}`,
    }),
    content,
  });
  return editor;
}

/** A keystroke: a text insertion at the caret with no paste metadata. */
function type(current: Editor, text: string) {
  current.view.dispatch(current.state.tr.insertText(text));
}

function anchors(current: Editor): unknown[] {
  const found: unknown[] = [];
  current.state.doc.descendants((node) => {
    if (node.attrs.audioAnchor) found.push(node.attrs.audioAnchor);
  });
  return found;
}

function startRecording(atMs: number, noteId = 'note-1') {
  vi.useFakeTimers();
  vi.setSystemTime(10_000_000 + atMs);
  recording = { recordingId: 'rec-1', noteId, startedAt: 10_000_000 };
}

describe('anchoring blocks to a recording', () => {
  it('anchors a paragraph the moment it is first typed into', () => {
    const current = open('<p></p>');
    startRecording(83_250);
    current.commands.setTextSelection(1);

    type(current, 'E');
    type(current, 'n');

    expect(anchors(current)).toEqual([{ recordingId: 'rec-1', offsetMs: 83_250 }]);
  });

  it('never moves an anchor when the block is edited later', () => {
    const current = open('<p></p>');
    startRecording(1_000);
    current.commands.setTextSelection(1);
    type(current, 'x');
    vi.setSystemTime(10_000_000 + 60_000);
    type(current, 'yz');
    expect(anchors(current)).toEqual([{ recordingId: 'rec-1', offsetMs: 1_000 }]);
  });

  it('leaves blocks that already had words alone', () => {
    const current = open('<p>written before the lecture</p>');
    startRecording(5_000);
    current.commands.setTextSelection(3);
    type(current, 'x');
    expect(anchors(current)).toEqual([]);
  });

  it('anchors nothing when no recording is running, or it belongs to another note', () => {
    const idle = open('<p></p>');
    idle.commands.setTextSelection(1);
    type(idle, 'x');
    expect(anchors(idle)).toEqual([]);
    idle.destroy();

    const elsewhere = open('<p></p>');
    startRecording(5_000, 'another-note');
    elsewhere.commands.setTextSelection(1);
    type(elsewhere, 'x');
    expect(anchors(elsewhere)).toEqual([]);
  });

  it('does not count a paragraph’s worth of inserted text as typing', () => {
    const current = open('<p></p>');
    startRecording(5_000);
    current.commands.setTextSelection(1);
    type(
      current,
      'A definition the Define dialog inserted, far longer than a keystroke.',
    );
    expect(anchors(current)).toEqual([]);
  });

  it('gives a block split off with Enter no inherited anchor', () => {
    const current = open('<p></p>');
    startRecording(1_000);
    current.commands.setTextSelection(1);
    type(current, 'first');
    current.commands.splitBlock();
    expect(anchors(current)).toHaveLength(1);
    vi.setSystemTime(10_000_000 + 9_000);
    type(current, 's');
    expect(anchors(current)).toEqual([
      { recordingId: 'rec-1', offsetMs: 1_000 },
      { recordingId: 'rec-1', offsetMs: 9_000 },
    ]);
  });

  it('strips anchors from pasted content', () => {
    const current = open('<p></p>');
    const transform = current.state.plugins.find(
      (plugin) => plugin.spec.key === lectureAnchorsPluginKey,
    )!.props.transformPasted!;
    const pasted = current.schema.nodeFromJSON({
      type: 'paragraph',
      attrs: { audioAnchor: { recordingId: 'rec-9', offsetMs: 4 } },
      content: [{ type: 'text', text: 'copied' }],
    });
    const slice = transform.call(
      current.state.plugins[0]!,
      new Slice(current.schema.nodes.doc!.create(null, pasted).content, 0, 0),
      current.view,
      false,
    );
    expect(slice.content.firstChild?.attrs.audioAnchor).toBeNull();
  });

  it('survives the JSON the note is saved as', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { audioAnchor: { recordingId: 'rec-1', offsetMs: 42_000 } },
          content: [{ type: 'text', text: 'on the exam' }],
        },
      ],
    };
    const current = open(doc);
    expect(anchors(current)).toEqual([{ recordingId: 'rec-1', offsetMs: 42_000 }]);
    expect(current.getHTML()).toContain('data-audio-anchor="rec-1@42000"');
  });
});

describe('anchor markers', () => {
  const anchored = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        attrs: { audioAnchor: { recordingId: 'rec-1', offsetMs: 42_000 } },
        content: [{ type: 'text', text: 'on the exam' }],
      },
    ],
  };

  it('shows a marker only once the recording exists on the note', () => {
    const play = vi.fn();
    const current = open(anchored, play);
    expect(current.view.dom.querySelector('.nb-audio-anchor')).toBeNull();

    available = new Set(['rec-1']);
    refreshLectureAnchors(current.view);
    const marker = current.view.dom.querySelector<HTMLButtonElement>('.nb-audio-anchor');
    expect(marker?.getAttribute('aria-label')).toBe('Play from 0:42');

    marker!.click();
    expect(play).toHaveBeenCalledWith({ recordingId: 'rec-1', offsetMs: 42_000 });
  });
});

describe('parseAudioAnchor', () => {
  it('reads both the HTML and the JSON forms, and nothing else', () => {
    expect(parseAudioAnchor('rec-1@42000')).toEqual({
      recordingId: 'rec-1',
      offsetMs: 42_000,
    });
    expect(parseAudioAnchor({ recordingId: 'rec-1', offsetMs: 5 })).toEqual({
      recordingId: 'rec-1',
      offsetMs: 5,
    });
    expect(parseAudioAnchor('../x@1')).toBeNull();
    expect(parseAudioAnchor({ recordingId: 'rec-1', offsetMs: -1 })).toBeNull();
    expect(parseAudioAnchor(null)).toBeNull();
  });

  it('formats offsets the way a player does', () => {
    expect(formatOffset(4_900)).toBe('0:04');
    expect(formatOffset(65_000)).toBe('1:05');
    expect(formatOffset(3_723_000)).toBe('1:02:03');
  });
});
