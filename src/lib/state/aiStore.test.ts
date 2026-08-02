/**
 * Thread isolation.
 *
 * The store already kept strict and knowledge conversations apart so a strict
 * answer could never inherit one that was allowed to use outside knowledge.
 * Scope needs the same separation for the same reason, and these assert it.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { threadKey, useAiStore } from './aiStore';

describe('ask threads', () => {
  beforeEach(() => {
    useAiStore.setState({ threads: {}, askMode: 'knowledge', askScope: 'note' });
  });

  it('keeps scopes apart, not just modes', () => {
    const store = useAiStore.getState();
    store.commitTurn('note-1', threadKey('note', 'note'), {
      role: 'user',
      content: 'about this note',
    });
    store.commitTurn('note-1', threadKey('note', 'library'), {
      role: 'user',
      content: 'about everything',
    });

    const threads = useAiStore.getState().threads['note-1'];
    expect(threads?.[threadKey('note', 'note')]?.turns).toHaveLength(1);
    expect(threads?.[threadKey('note', 'library')]?.turns).toHaveLength(1);
    expect(threads?.[threadKey('note', 'note')]?.turns[0]?.content).toBe(
      'about this note',
    );
  });

  it('keeps modes apart within one scope', () => {
    const store = useAiStore.getState();
    store.commitTurn('note-1', threadKey('note', 'library'), {
      role: 'user',
      content: 'strict',
    });
    const threads = useAiStore.getState().threads['note-1'];
    expect(threads?.[threadKey('knowledge', 'library')]).toBeUndefined();
  });

  it('forgets a note only once its last thread is gone', () => {
    const store = useAiStore.getState();
    store.commitTurn('note-1', threadKey('note', 'note'), { role: 'user', content: 'a' });
    store.commitTurn('note-1', threadKey('note', 'library'), {
      role: 'user',
      content: 'b',
    });

    store.clearThread('note-1', threadKey('note', 'note'));
    expect(useAiStore.getState().threads['note-1']).toBeDefined();

    store.clearThread('note-1', threadKey('note', 'library'));
    // A composite key means the old two-mode emptiness check would have left an
    // empty record behind here forever.
    expect(useAiStore.getState().threads['note-1']).toBeUndefined();
  });

  it('carries the sources of an answer without persisting anything', () => {
    const store = useAiStore.getState();
    store.commitTurn('note-1', threadKey('note', 'library'), {
      role: 'assistant',
      content: 'answered',
      sources: [{ noteId: 'other', title: 'Other', truncated: true, score: 0.42 }],
      droppedCount: 3,
    });

    const thread = useAiStore.getState().threads['note-1']?.[threadKey('note', 'library')];
    expect(thread?.turns[0]?.sources).toEqual([
      { noteId: 'other', title: 'Other', truncated: true, score: 0.42 },
    ]);
    expect(thread?.turns[0]?.droppedCount).toBe(3);
  });
});
