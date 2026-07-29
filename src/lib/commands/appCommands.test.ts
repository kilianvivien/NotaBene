import { beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryLibraryAdapter } from '@/lib/adapters/library/memoryLibraryAdapter';
import { externalLinks, library } from '@/lib/adapters';
import { useEditorStore } from '@/lib/state/editorStore';
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

function findPredefined(nodes: MenuNode[], role: string): MenuNode | undefined {
  for (const node of nodes) {
    if (node.kind === 'predefined' && node.role === role) return node;
    if (node.kind === 'submenu') {
      const match = findPredefined(node.items, role);
      if (match) return match;
    }
  }
  return undefined;
}

beforeEach(() => {
  vi.restoreAllMocks();
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

  /**
   * Every command that actually works is reachable from the keyboard.
   *
   * The menu bar is generated from this table, so an entry without an
   * accelerator is a menu item with a blank right-hand column — which reads as
   * "this one has no shortcut" rather than as an oversight. Commands from
   * unshipped phases are exempt: they render disabled, and a shortcut for
   * something that refuses itself is worse than none.
   */
  it('gives every shipped command a keyboard shortcut', () => {
    const missing = APP_COMMAND_IDS.filter(
      (id) => isCommandAvailable(id) && !APP_COMMANDS[id].accelerator,
    );
    expect(missing).toEqual([]);
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

  it('passes a localized label to the native fullscreen item', () => {
    const fullscreen = findPredefined(
      buildMenuBar((key) => `translated:${key}`),
      'fullscreen',
    );
    expect(fullscreen).toMatchObject({
      kind: 'predefined',
      role: 'fullscreen',
      label: 'translated:menu.fullscreen',
    });
  });

  it('passes localized labels for every native system role', () => {
    const menu = buildMenuBar((key) => `translated:${key}`);
    const visit = (nodes: MenuNode[]) => {
      for (const node of nodes) {
        if (node.kind === 'predefined') {
          expect(node.label, node.role).toContain('translated:');
        } else if (node.kind === 'submenu') {
          visit(node.items);
        }
      }
    };
    visit(menu);
  });

  it('includes the GitHub repository in the Help menu', () => {
    const help = buildMenuBar((key) => key).find(
      (node) => node.kind === 'submenu' && node.label === 'menu.help',
    );
    expect(help).toMatchObject({
      kind: 'submenu',
      items: expect.arrayContaining([
        expect.objectContaining({ kind: 'item', id: 'help.github', enabled: true }),
      ]),
    });
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

  it('opens the NotaBene GitHub repository', async () => {
    const open = vi.spyOn(externalLinks, 'open').mockResolvedValue();
    const result = await runAppCommand('help.github');
    expect(result.ok).toBe(true);
    expect(open).toHaveBeenCalledWith('https://github.com/kilianvivien/NotaBene');
  });

  it('refuses a command whose feature has not shipped, naming the phase', async () => {
    const result = await runAppCommand('help.documentation');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('not_supported');
      expect(result.message).toContain('phase H');
    }
  });

  // The study features act on the open note, so refusing early is the honest
  // answer — a dialog whose only message is "no note selected" is not.
  it('refuses a study command with no note open', async () => {
    await useEditorStore.getState().closeNote();
    const result = await runAppCommand('ai.flashcards');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('not_found');
  });
});
