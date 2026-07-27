/**
 * The TypeScript half of the wire-shape contract test.
 *
 * `fixtures/wire-note.json` is one note written out exactly as it travels over
 * IPC. This file asserts the Zod schema accepts it *and returns it unchanged* —
 * no defaults filled in, no fields dropped. The Rust half
 * (`src-tauri/src/db/notes.rs`) reads the same file, pushes it through serde,
 * SQLite, and back, and asserts the same thing.
 *
 * Between them they pin all three faces of the contract (plan §1.4) to one
 * document: a field added to the Zod schema but not to the Rust struct, or a
 * column that quietly rounds a value, fails here rather than in a user's
 * library six months later.
 */
import { describe, expect, it } from 'vitest';
import { NoteSchema } from './schema';
import fixture from './fixtures/wire-note.json';

describe('wire shape', () => {
  it('parses the shared fixture', () => {
    expect(NoteSchema.safeParse(fixture).success).toBe(true);
  });

  it('round-trips the fixture without adding or dropping a field', () => {
    // Defaults are what make this worth asserting: if the fixture were missing
    // a field, Zod would happily supply one and the JSON Rust reads would no
    // longer be the JSON TypeScript produces.
    expect(NoteSchema.parse(fixture)).toEqual(fixture);
  });

  it('keeps the fixture serialisable to exactly the bytes on disk', () => {
    const parsed = NoteSchema.parse(fixture);
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(fixture);
  });
});
