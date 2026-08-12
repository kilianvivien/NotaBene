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
        command('app.commandPalette', t),
        command('app.settings', t),
        separator,
        { kind: 'predefined', role: 'services', label: t('menu.services') },
        separator,
        { kind: 'predefined', role: 'hide', label: `${t('menu.hide')} ${appName}` },
        { kind: 'predefined', role: 'hideOthers', label: t('menu.hideOthers') },
        { kind: 'predefined', role: 'showAll', label: t('menu.showAll') },
        separator,
        { kind: 'predefined', role: 'quit', label: `${t('menu.quit')} ${appName}` },
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
        command('note.importDocument', t),
        separator,
        command('note.save', t),
        separator,
        command('note.merge', t),
        command('note.export', t),
        separator,
        command('backup.create', t),
        command('backup.restore', t),
        separator,
        { kind: 'predefined', role: 'closeWindow', label: t('menu.closeWindow') },
      ],
    },
    {
      kind: 'submenu',
      label: t('menu.edit'),
      items: [
        // Undo and friends must be the OS roles: the editor is a native text
        // field as far as macOS is concerned, and only the responder chain
        // knows what Cmd-Z means inside it.
        { kind: 'predefined', role: 'undo', label: t('menu.undo') },
        { kind: 'predefined', role: 'redo', label: t('menu.redo') },
        separator,
        { kind: 'predefined', role: 'cut', label: t('menu.cut') },
        { kind: 'predefined', role: 'copy', label: t('menu.copy') },
        { kind: 'predefined', role: 'paste', label: t('menu.paste') },
        { kind: 'predefined', role: 'selectAll', label: t('menu.selectAll') },
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
        separator,
        command('note.readAloud', t),
        { kind: 'predefined', role: 'fullscreen', label: t('menu.fullscreen') },
      ],
    },
    {
      kind: 'submenu',
      label: t('menu.ai'),
      items: [
        command('ai.agent', t),
        separator,
        command('ai.rewrite', t),
        command('ai.synthesize', t),
        command('ai.ask', t),
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
        { kind: 'predefined', role: 'minimize', label: t('menu.minimize') },
        { kind: 'predefined', role: 'maximize', label: t('menu.maximize') },
        separator,
        {
          kind: 'predefined',
          role: 'bringAllToFront',
          label: t('menu.bringAllToFront'),
        },
      ],
    },
    {
      kind: 'submenu',
      label: t('menu.help'),
      items: [command('help.documentation', t), separator, command('help.github', t)],
    },
  ];
}
