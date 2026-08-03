/**
 * Every `invoke` name must be a command Rust actually registered.
 *
 * This boundary is the one place a typo survives both test suites: TypeScript
 * only sees a string, Rust only sees a function it was never asked about, and
 * the failure appears at runtime in the desktop build as "command not found" —
 * the one build a Linux CI box cannot start. Reading both files is blunt, and
 * it is the cheapest way to make that mismatch fail here instead.
 *
 * The same trick `migrations.rs` already uses to pin SCHEMA_VERSION across the
 * two languages.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../../../..');
const adapter = readFileSync(
  resolve(root, 'src/lib/adapters/library/tauriLibraryAdapter.ts'),
  'utf8',
);
const handlers = readFileSync(resolve(root, 'src-tauri/src/lib.rs'), 'utf8');
const commands = readFileSync(resolve(root, 'src-tauri/src/commands.rs'), 'utf8');

function invoked(): string[] {
  return [...adapter.matchAll(/invoke(?:<[^>]*>)?\(\s*'([a-z0-9_]+)'/g)].map(
    (match) => match[1]!,
  );
}

describe('library invoke contract', () => {
  it('finds the commands it is supposed to check', () => {
    // A regex that silently matched nothing would make every assertion below
    // vacuously true.
    expect(invoked().length).toBeGreaterThan(20);
    expect(invoked()).toContain('library_search_notes');
  });

  it('registers every invoked command in the Tauri handler list', () => {
    const missing = invoked().filter(
      (name) => !handlers.includes(`commands::${name},`),
    );
    expect(missing, 'not in generate_handler![] in src-tauri/src/lib.rs').toEqual([]);
  });

  it('defines every invoked command in commands.rs', () => {
    const missing = invoked().filter(
      (name) => !commands.includes(`pub fn ${name}(`) && !commands.includes(`pub async fn ${name}(`),
    );
    expect(missing, 'no #[tauri::command] with that name').toEqual([]);
  });
});
