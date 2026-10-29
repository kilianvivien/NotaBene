import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assets } from '@/lib/adapters';
import { memoryLibraryAdapter } from '@/lib/adapters/library/memoryLibraryAdapter';
import { useEditorStore } from '@/lib/state/editorStore';
import { ImageDrawingPlanSchema, type NoteDoc } from '@/lib/schema';
import { inlineImages } from '@/lib/notes/imageTargets';
import type { ImageDrawingResult } from '@/lib/ai/imageDrawing';
import { createNoteCommand, updateNoteCommand } from './noteCommands';
import {
  proposeImageDrawingCommand,
  insertImageDrawingCommand,
} from './imageDrawingCommands';

const mocks = vi.hoisted(() => ({ request: vi.fn(), prepare: vi.fn() }));
vi.mock('@/lib/images/vision', () => ({ imageForVision: mocks.prepare }));
vi.mock('@/lib/ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai')>()),
  requestImageDrawing: mocks.request,
}));
vi.mock('./aiCommands', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./aiCommands')>()),
  providerFor: async () => ({ ok: true, provider: { model: 'vision-model' } }),
}));

const image = { type: 'image', attrs: { assetId: 'asset', caption: 'Delegation' } };
const paragraph = {
  type: 'paragraph',
  content: [{ type: 'text', text: 'Keep this text' }],
};
const result: ImageDrawingResult = {
  plan: ImageDrawingPlanSchema.parse({
    title: 'Delegation',
    elements: [{ type: 'rectangle', x: 0, y: 0, width: 200, height: 100 }],
  }),
  scene: {
    data: { elements: [{ type: 'rectangle' }], appState: {}, files: {} },
    svg: '<svg />',
  },
};
async function fixture(
  doc: NoteDoc = { type: 'doc', content: [paragraph, image, paragraph] },
) {
  const created = await createNoteCommand({ doc });
  if (!created.ok) throw new Error(created.message);
  const target = { noteId: created.value.id, ...inlineImages(created.value.doc)[0]! };
  return { note: created.value, target };
}

beforeEach(() => {
  memoryLibraryAdapter.reset();
  useEditorStore.setState({ note: null });
  vi.clearAllMocks();
});

describe('image reconstruction', () => {
  it('reads the actual inline asset and sends its bytes to the vision model', async () => {
    const { target } = await fixture();
    const blob = new Blob(['image bytes'], { type: 'image/png' });
    vi.spyOn(assets, 'get').mockResolvedValueOnce(blob);
    const input = { mimeType: 'image/png', data: 'aW1hZ2U=' };
    mocks.prepare.mockResolvedValueOnce(input);
    mocks.request.mockResolvedValueOnce(result);
    expect(await proposeImageDrawingCommand(target)).toEqual({ ok: true, value: result });
    expect(assets.get).toHaveBeenCalledWith('asset');
    expect(mocks.prepare).toHaveBeenCalledWith(blob);
    expect(mocks.request).toHaveBeenCalledWith(
      { provider: { model: 'vision-model' }, image: input },
      {},
    );
  });
  it('inserts beside the exact image and retains surrounding content', async () => {
    const { target } = await fixture();
    const saved = await insertImageDrawingCommand(target, result);
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error(saved.message);
    expect(saved.value.doc.content.map((node) => node.type)).toEqual([
      'paragraph',
      'image',
      'drawing',
      'paragraph',
    ]);
    expect(saved.value.doc.content[2]?.attrs).toMatchObject({
      title: 'Delegation',
      svg: '<svg />',
    });
  });
  it('replaces only the chosen occurrence, including inside nested content', async () => {
    const { note } = await fixture({
      type: 'doc',
      content: [image, { type: 'blockquote', content: [image, paragraph] }],
    });
    const target = { noteId: note.id, ...inlineImages(note.doc)[1]! };
    const saved = await insertImageDrawingCommand(target, result, 'replace');
    if (!saved.ok) throw new Error(saved.message);
    expect(saved.value.doc.content[0]?.type).toBe('image');
    expect(saved.value.doc.content[1]?.content?.map((node) => node.type)).toEqual([
      'drawing',
      'paragraph',
    ]);
  });
  it('refuses when the image was moved or replaced while the preview was open', async () => {
    const { note, target } = await fixture();
    await updateNoteCommand({
      noteId: note.id,
      doc: { type: 'doc', content: [image, paragraph] },
    });
    expect(await insertImageDrawingCommand(target, result, 'replace')).toMatchObject({
      ok: false,
      code: 'conflict',
    });
    expect(
      (await memoryLibraryAdapter.getNote(note.id))?.doc.content.map((node) => node.type),
    ).toEqual(['image', 'paragraph']);
  });
  it('refuses a stale agent version and keeps its journal context on successful writes', async () => {
    const { note, target } = await fixture();
    const context = { source: 'agent' as const, agentRunId: 'vision-run' };
    const stale = await insertImageDrawingCommand(target, result, 'replace', {
      context,
      baseUpdatedAt: '2000-01-01T00:00:00.000Z',
    });
    expect(stale).toMatchObject({ ok: false, code: 'conflict' });
    const saved = await insertImageDrawingCommand(target, result, 'replace', {
      context,
      baseUpdatedAt: note.updatedAt,
    });
    expect(saved.ok).toBe(true);
    const snapshots = await memoryLibraryAdapter.listSnapshots(note.id);
    expect(snapshots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ cause: 'agent', runId: 'vision-run' }),
      ]),
    );
  });
});
