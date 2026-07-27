/**
 * The macOS menu bar, described in terms of the command table.
 *
 * Structure lives here; behaviour lives in `appCommands.ts`; the `NSMenu` lives
 * in Rust. A command that is not yet implemented still gets its menu item —
 * disabled, with the phase it lands in in the tooltip's place — because a
 * Format menu that appears only in Phase B looks like a bug, while a greyed one
 * looks like a roadmap.
 */
import type { MenuNode } from '@/lib/adapters';
import { APP_COMMANDS, isCommandAvailable, type AppCommandId } from '@/lib/commands';

type Translate = (key: string) => string;

function command(id: AppCommandId, t: Translate): MenuNode {
  const entry = APP_COMMANDS[id];
  return {
    kind: 'item',
    id,
    label: t(entry.labelKey),
    accelerator: entry.accelerator,
    enabled: isCommandAvailable(id),
  };
}

const separator: MenuNode = { kind: 'separator' };

export function buildMenuBar(t: Translate): MenuNode[] {
  const appName = t('app.name');

  return [
    {
      kind: 'submenu',
      label: appName,
      items: [
        { kind: 'predefined', role: 'about', label: `${t('menu.about')} ${appName}` },
        separator,
        command('app.settings', t),
        separator,
        { kind: 'predefined', role: 'services' },
        separator,
        { kind: 'predefined', role: 'hide' },
        { kind: 'predefined', role: 'hideOthers' },
        { kind: 'predefined', role: 'showAll' },
        separator,
        { kind: 'predefined', role: 'quit' },
      ],
    },
    {
      kind: 'submenu',
      label: t('menu.file'),
      items: [
        command('note.new', t),
        command('note.quick', t),
        command('note.newFromTemplate', t),
        command('course.new', t),
        separator,
        command('note.save', t),
        separator,
        { kind: 'predefined', role: 'closeWindow' },
      ],
    },
    {
      kind: 'submenu',
      label: t('menu.edit'),
      items: [
        // Undo and friends must be the OS roles: the editor is a native text
        // field as far as macOS is concerned, and only the responder chain
        // knows what Cmd-Z means inside it.
        { kind: 'predefined', role: 'undo' },
        { kind: 'predefined', role: 'redo' },
        separator,
        { kind: 'predefined', role: 'cut' },
        { kind: 'predefined', role: 'copy' },
        { kind: 'predefined', role: 'paste' },
        { kind: 'predefined', role: 'selectAll' },
        separator,
        command('edit.find', t),
      ],
    },
    {
      kind: 'submenu',
      label: t('menu.format'),
      items: [
        command('format.bold', t),
        command('format.italic', t),
        command('format.underline', t),
        command('format.highlight', t),
        separator,
        command('format.code', t),
      ],
    },
    {
      kind: 'submenu',
      label: t('menu.insert'),
      items: [
        command('insert.image', t),
        command('insert.drawing', t),
        command('insert.table', t),
        command('insert.callout', t),
        command('insert.math', t),
        separator,
        command('insert.link', t),
      ],
    },
    {
      kind: 'submenu',
      label: t('menu.view'),
      items: [
        command('view.toggleSidebar', t),
        command('view.toggleInspector', t),
        separator,
        command('view.focusMode', t),
        { kind: 'predefined', role: 'fullscreen' },
      ],
    },
    {
      kind: 'submenu',
      label: t('menu.ai'),
      items: [
        command('ai.rewrite', t),
        command('ai.synthesize', t),
        separator,
        command('ai.mindMap', t),
        command('ai.flashcards', t),
        command('ai.podcast', t),
      ],
    },
    {
      kind: 'submenu',
      label: t('menu.window'),
      items: [
        { kind: 'predefined', role: 'minimize' },
        { kind: 'predefined', role: 'maximize' },
        separator,
        { kind: 'predefined', role: 'bringAllToFront' },
      ],
    },
    {
      kind: 'submenu',
      label: t('menu.help'),
      items: [command('help.documentation', t)],
    },
  ];
}
