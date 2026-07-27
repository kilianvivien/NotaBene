import type { DragEvent } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { dragCarries, endDrag, NOTE_MIME, readDrag, startDrag } from './dnd';

function dragEvent(dataTransfer: Partial<DataTransfer>): DragEvent {
  return {
    dataTransfer: {
      effectAllowed: 'uninitialized',
      types: [],
      getData: () => '',
      setData: () => undefined,
      ...dataTransfer,
    },
  } as unknown as DragEvent;
}

beforeEach(endDrag);

describe('internal drag payloads', () => {
  it('uses the typed DataTransfer payload when WebKit exposes it', () => {
    const event = dragEvent({
      types: [NOTE_MIME],
      getData: (type) => (type === NOTE_MIME ? 'note-1' : ''),
    });

    expect(dragCarries(event, 'note')).toBe(true);
    expect(readDrag(event, 'note')).toBe('note-1');
  });

  it('keeps the payload available when WKWebView hides custom MIME types', () => {
    startDrag(
      dragEvent({
        setData: () => undefined,
      }),
      'note',
      'note-2',
      'A note',
    );
    const tauriDragOver = dragEvent({
      types: ['text/plain'],
      getData: () => '',
    });

    expect(dragCarries(tauriDragOver, 'note')).toBe(true);
    expect(readDrag(tauriDragOver, 'note')).toBe('note-2');

    endDrag();
    expect(dragCarries(tauriDragOver, 'note')).toBe(false);
  });
});
