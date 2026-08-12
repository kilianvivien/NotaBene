/**
 * Forward migrations for persisted libraries.
 *
 * Every backup and every full export carries a `schemaVersion`. On import we
 * run it up to `SCHEMA_VERSION` one step at a time, then validate — so a
 * migration only has to know how to get from N to N+1, and the schema stays the
 * only thing that decides whether the result is acceptable.
 */
import { LibrarySchema, SCHEMA_VERSION, type Library } from './schema';

/** One step of the ladder. Operates on unvalidated JSON, by necessity. */
type Migration = (input: Record<string, unknown>) => Record<string, unknown>;

/** Keyed by the version being migrated *from*. */
const MIGRATIONS: Record<number, Migration> = {
  // v2 changes SQLite's derived FTS index and template join table, not the
  // backup envelope. The explicit identity step still matters: old backups
  // must advance through the same numbered ladder as the database.
  1: (input) => input,
  // v3 adds a visual color to tags. Existing backups predate the field, so
  // they inherit the same warm neutral used for newly created tags.
  2: (input) => ({
    ...input,
    tags: Array.isArray(input.tags)
      ? input.tags.map((tag) =>
          typeof tag === 'object' && tag !== null
            ? { color: '#9b5c2f', ...(tag as Record<string, unknown>) }
            : tag,
        )
      : input.tags,
  }),
  // v4 ties agent-written versions into one undoable run. Older versions are
  // ordinary history entries and therefore belong to no run.
  3: (input) => ({
    ...input,
    snapshots: Array.isArray(input.snapshots)
      ? input.snapshots.map((snapshot) =>
          typeof snapshot === 'object' && snapshot !== null
            ? { runId: null, ...(snapshot as Record<string, unknown>) }
            : snapshot,
        )
      : input.snapshots,
  }),
};

export type ImportResult =
  | { ok: true; library: Library; migratedFrom: number }
  | { ok: false; error: string; issues?: string[] };

/**
 * Parse untrusted library JSON: a backup file, an `.notabene-backup` payload,
 * or anything an agent handed us. Never throws — callers get a result they must
 * branch on, which is what keeps a malformed file from taking down the app.
 */
export function safeImportLibrary(input: unknown): ImportResult {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, error: 'not an object' };
  }

  const record = { ...(input as Record<string, unknown>) };
  const declared = record.schemaVersion;
  if (typeof declared !== 'number' || !Number.isInteger(declared) || declared < 1) {
    return { ok: false, error: 'missing or invalid schemaVersion' };
  }
  if (declared > SCHEMA_VERSION) {
    return {
      ok: false,
      error: `library was written by a newer NotaBene (schema v${declared}, this build understands v${SCHEMA_VERSION})`,
    };
  }

  let working = record;
  for (let version = declared; version < SCHEMA_VERSION; version += 1) {
    const migrate = MIGRATIONS[version];
    if (!migrate) {
      return { ok: false, error: `no migration from schema v${version}` };
    }
    working = migrate(working);
    working.schemaVersion = version + 1;
  }

  const parsed = LibrarySchema.safeParse(working);
  if (!parsed.success) {
    return {
      ok: false,
      error: 'library failed validation',
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
      ),
    };
  }

  return { ok: true, library: parsed.data, migratedFrom: declared };
}
