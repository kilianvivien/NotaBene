import { afterEach, describe, expect, it, vi } from 'vitest';
import { Editor, Node } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { undo } from '@tiptap/pm/history';
import {
  ImageDrawingJobs,
  adoptImageDrawing,
  imageDrawingJobAt,
  placeImageDrawing,
  stepPastImage,
  trackImageDrawing,
  trackedImageDrawing,
  untrackImageDrawing,
} from './ImageDrawingJobs';

// Plain stand-ins for the React node views: the plugin only cares about types
// and the asset id.
const Image = Node.create({
  name: 'image',
  group: 'block',
  atom: true,
  addAttributes: () => ({ assetId: { default: '' }, caption: { default: '' } }),
  parseHTML: () => [{ tag: 'figure[data-image]' }],
  renderHTML: () => ['figure', { 'data-image': '' }],
});
const Drawing = Node.create({
  name: 'drawing',
  group: 'block',
  atom: true,
  addAttributes: () => ({
    data: { default: null },
    svg: { default: '' },
    title: { default: '' },
  }),
  parseHTML: () => [{ tag: 'figure[data-drawing]' }],
  renderHTML: () => ['figure', { 'data-drawing': '' }],
});

const drawing = {
  type: 'drawing',
  attrs: { data: null, svg: '<svg />', title: 'Matrix' },
};
let editor: Editor;

function setup(onLost = vi.fn()) {
  editor = new Editor({
    extensions: [StarterKit, Image, Drawing, ImageDrawingJobs.configure({ onLost })],
    content: {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Before' }] },
        { type: 'image', attrs: { assetId: 'asset' } },
        { type: 'paragraph', content: [{ type: 'text', text: 'After' }] },
      ],
    },
  });
  const pos = editor.state.doc.child(0).nodeSize;
  return { onLost, pos };
}

const types = () => editor.getJSON().content!.map((node) => node.type);

afterEach(() => editor?.destroy());

describe('image drawing jobs', () => {
  it('follows the image while the student writes above it, then places the drawing below', () => {
    const { pos } = setup();
    expect(trackImageDrawing(editor.view, 'job', pos)).toBe(true);
    expect(imageDrawingJobAt(editor.state, pos)).toBe('job');

    editor.commands.insertContentAt(1, 'Lecture notes. ');
    editor.commands.insertContentAt(0, {
      type: 'paragraph',
      content: [{ type: 'text', text: 'A new first line' }],
    });
    const moved = trackedImageDrawing(editor.state, 'job')!.image;
    expect(editor.state.doc.nodeAt(moved)?.type.name).toBe('image');

    expect(placeImageDrawing(editor, 'job', drawing)).toBe(true);
    expect(types()).toEqual(['paragraph', 'paragraph', 'image', 'drawing', 'paragraph']);
    expect(trackedImageDrawing(editor.state, 'job')?.drawing).toBe(moved + 1);
  });

  it('keeps following the image through a caption edit', () => {
    const { pos, onLost } = setup();
    trackImageDrawing(editor.view, 'job', pos);
    editor.view.dispatch(
      editor.state.tr.setNodeMarkup(pos, undefined, { assetId: 'asset', caption: 'Hi' }),
    );
    expect(trackedImageDrawing(editor.state, 'job')?.image).toBe(pos);
    expect(onLost).not.toHaveBeenCalled();
  });

  it('reports the job lost when the image is deleted, so the request is stopped', () => {
    const { pos, onLost } = setup();
    trackImageDrawing(editor.view, 'job', pos);
    editor.view.dispatch(editor.state.tr.delete(pos, pos + 1));
    expect(onLost).toHaveBeenCalledWith('job');
    expect(placeImageDrawing(editor, 'job', drawing)).toBe(false);
  });

  it('ends the job when the drawing is discarded or the bar dismissed', () => {
    const { pos, onLost } = setup();
    trackImageDrawing(editor.view, 'job', pos);
    placeImageDrawing(editor, 'job', drawing);
    const at = trackedImageDrawing(editor.state, 'job')!.drawing!;
    editor.view.dispatch(editor.state.tr.delete(at, at + 1));
    expect(onLost).toHaveBeenCalledWith('job');
    expect(types()).toEqual(['paragraph', 'image', 'paragraph']);

    trackImageDrawing(editor.view, 'other', pos);
    untrackImageDrawing(editor.view, 'other');
    expect(onLost).toHaveBeenCalledWith('other');
  });

  it('places the drawing as its own undo step', () => {
    const { pos } = setup();
    trackImageDrawing(editor.view, 'job', pos);
    editor.commands.insertContentAt(editor.state.doc.content.size - 1, ' typed');
    placeImageDrawing(editor, 'job', drawing);
    undo(editor.state, editor.view.dispatch);
    expect(types()).toEqual(['paragraph', 'image', 'paragraph']);
    expect(editor.getText()).toContain('After typed');
  });

  it('moves the caret off the image so typing cannot replace it', () => {
    const { pos } = setup();
    editor.commands.setNodeSelection(pos);
    stepPastImage(editor, pos);
    expect(editor.state.selection.from).toBe(pos + 2);
    editor.commands.insertContent('x');
    expect(types()).toEqual(['paragraph', 'image', 'paragraph']);
  });

  it('picks a running job back up in a freshly opened editor', () => {
    const { pos } = setup();
    const target = {
      noteId: 'n',
      path: [1],
      image: { type: 'image', attrs: { assetId: 'asset' } },
    };
    expect(adoptImageDrawing(editor, 'job', target)).toBe(true);
    expect(trackedImageDrawing(editor.state, 'job')?.image).toBe(pos);
  });
});
