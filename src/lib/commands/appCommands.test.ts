import { beforeEach, describe, expect, it } from 'vitest';
import { memoryLibraryAdapter } from '@/lib/adapters/library/memoryLibraryAdapter';
import { library } from '@/lib/adapters';
import { useUiStore } from '@/lib/state/uiStore';
import {
  APP_COMMANDS,
  APP_COMMAND_IDS,
  isCommandAvailable,
  runAppCommand,
} from './appCommands';
import { buildMenuBar } from '@/app/menuBar';
import type { MenuNode } from '@/lib/adapters';

function itemIds(nodes: MenuNode[]): string[] {
  return nodes.flatMap((node) => {
    if (node.kind === 'submenu') return itemIds(node.items);
    return node.kind === 'item' ? [node.id] : [];
  });
}

beforeEach(() => {
  memoryLibraryAdapter.reset();
});

describe('the command table', () => {
  it('has an entry for every id, keyed by that id', () => {
    for (const id of APP_COMMAND_IDS) {
      expect(APP_COMMANDS[id].id).toBe(id);
    }
  });

  it('gives every command a label key', () => {
    for (const id of APP_COMMAND_IDS) {
      expect(APP_COMMANDS[id].labelKey).toBeTruthy();
    }
  });

  it('assigns each accelerator to at most one command', () => {
    const accelerators = APP_COMMAND_IDS.map((id) => APP_COMMANDS[id].accelerator).filter(
      Boolean,
    );
    expect(new Set(accelerators).size).toBe(accelerators.length);
  });
});

describe('the menu bar', () => {
  // The whole point of building the menu from the table: an id can never
  // appear in the menu without a command behind it.
  it('names only ids the command router knows', () => {
    for (const id of itemIds(buildMenuBar((key) => key))) {
      expect(APP_COMMAND_IDS).toContain(id);
    }
  });

  it('offers every implemented command somewhere', () => {
    const inMenu = new Set(itemIds(buildMenuBar((key) => key)));
    for (const id of APP_COMMAND_IDS.filter(isCommandAvailable)) {
      expect(inMenu.has(id)).toBe(true);
    }
  });

  it('puts only submenus at the top level, as macOS requires', () => {
    for (const node of buildMenuBar((key) => key)) {
      expect(node.kind).toBe('submenu');
    }
  });
});

describe('runAppCommand', () => {
  it('creates and opens a note', async () => {
    const result = await runAppCommand('note.new');
    expect(result.ok).toBe(true);
    expect(await library.queryNotes({})).toHaveLength(1);
    expect(useUiStore.getState().selectedNoteId).not.toBeNull();
  });

  it('toggles chrome through the same path the menu uses', async () => {
    const before = useUiStore.getState().inspectorVisible;
    await runAppCommand('view.toggleInspector');
    expect(useUiStore.getState().inspectorVisible).toBe(!before);
  });

  it('refuses a command whose feature has not shipped, naming the phase', async () => {
    const result = await runAppCommand('ai.rewrite');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('not_supported');
      expect(result.message).toContain('phase E');
    }
  });
});
