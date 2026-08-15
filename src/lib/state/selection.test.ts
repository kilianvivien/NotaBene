/**
 * The rules the note list, the sidebar's drop targets and every dialog that
 * reads `multiSelection` all depend on. They are worth pinning down because
 * three of them are invisible until they are wrong: a selection that survives
 * opening a note, one that silently excludes the note you are reading, and a
 * right-click that acts on eleven notes instead of the one under the pointer.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { selectionFor, useUiStore } from './uiStore';
import type { Attachment } from '@/lib/schema';

const pdf: Attachment = {
  id: 'pdf-1',
  noteId: 'note-1',
  assetId: 'asset-1',
  name: 'paper.pdf',
  createdAt: '2026-08-12T08:00:00.000Z',
  annotations: [],
  url: null,
  fetchedAt: null,
};

beforeEach(() => {
  useUiStore.getState().selectNote(null);
});

describe('selectNote', () => {
  it('ends the bulk selection', () => {
    useUiStore.getState().setMultiSelection(['a', 'b', 'c']);
    useUiStore.getState().selectNote('d');
    expect(useUiStore.getState().multiSelection).toEqual([]);
    expect(useUiStore.getState().selectedNoteId).toBe('d');
  });

  it('keeps a PDF with its note and closes it when another note opens', () => {
    useUiStore.setState({ inspectorVisible: true });
    useUiStore.getState().openPdfReader(pdf, 4, 'highlight-1');
    expect(useUiStore.getState()).toMatchObject({
      // The reader is a full-window overlay: it leaves the panes alone.
      inspectorVisible: true,
      pdfReading: { attachment: pdf, page: 4, annotationId: 'highlight-1' },
    });

    useUiStore.getState().selectNote('note-1');
    expect(useUiStore.getState().pdfReading).not.toBeNull();
    useUiStore.getState().selectNote('note-2');
    expect(useUiStore.getState().pdfReading).toBeNull();
  });
});

describe('setView', () => {
  it('ends the bulk selection, since the notes in it may not be on screen', () => {
    useUiStore.getState().setMultiSelection(['a', 'b']);
    useUiStore.getState().setView({ kind: 'trash' });
    expect(useUiStore.getState().multiSelection).toEqual([]);
  });
});

describe('toggleInMultiSelection', () => {
  it('seeds from the open note, so it is not dropped from the action', () => {
    useUiStore.getState().selectNote('open');
    useUiStore.getState().toggleInMultiSelection('other');
    expect(useUiStore.getState().multiSelection).toEqual(['open', 'other']);
  });

  it('lets the open note be taken back out', () => {
    useUiStore.getState().selectNote('open');
    useUiStore.getState().toggleInMultiSelection('b');
    useUiStore.getState().toggleInMultiSelection('c');
    useUiStore.getState().toggleInMultiSelection('open');
    expect(useUiStore.getState().multiSelection).toEqual(['b', 'c']);
    expect(useUiStore.getState().selectedNoteId).toBe('open');
  });

  it('collapses to empty at one member, which every consumer reads as "none"', () => {
    useUiStore.getState().selectNote('open');
    useUiStore.getState().toggleInMultiSelection('other');
    useUiStore.getState().toggleInMultiSelection('other');
    expect(useUiStore.getState().multiSelection).toEqual([]);
  });

  it('does nothing on its own with no note open', () => {
    useUiStore.getState().toggleInMultiSelection('a');
    expect(useUiStore.getState().multiSelection).toEqual([]);
  });
});

describe('setMultiSelection', () => {
  it('drops duplicates a shift-range over a re-queried list could produce', () => {
    useUiStore.getState().setMultiSelection(['a', 'b', 'a']);
    expect(useUiStore.getState().multiSelection).toEqual(['a', 'b']);
  });

  it('treats a single note as no selection at all', () => {
    useUiStore.getState().setMultiSelection(['a']);
    expect(useUiStore.getState().multiSelection).toEqual([]);
  });
});

describe('selectionFor', () => {
  it('expands to the selection a note belongs to', () => {
    useUiStore.getState().setMultiSelection(['a', 'b']);
    expect(selectionFor('a')).toEqual(['a', 'b']);
  });

  it('stays with the one note when it is outside the selection', () => {
    useUiStore.getState().setMultiSelection(['a', 'b']);
    expect(selectionFor('c')).toEqual(['c']);
  });

  it('is just the note when nothing is selected', () => {
    expect(selectionFor('c')).toEqual(['c']);
  });
});
