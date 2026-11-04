/** Keep same-app note writes in order through persistence and editor sync.
 * Database concurrency guards still protect against writers outside this queue. */
const pending = new Map<string, Promise<unknown>>();

export async function withNoteWrite<T>(
  noteId: string,
  write: () => Promise<T>,
): Promise<T> {
  const previous = pending.get(noteId) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(write);
  pending.set(noteId, current);
  try {
    return await current;
  } finally {
    if (pending.get(noteId) === current) pending.delete(noteId);
  }
}
