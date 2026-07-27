/**
 * The application command table.
 *
 * Every menu item, every keyboard shortcut, and every chrome button that is not
 * note content resolves to one id in `APP_COMMAND_IDS` and one entry here. The
 * native macOS menu is *built from this table* (`src/lib/adapters/menu/`), so
 * the menu cannot drift from the commands and the labels arrive already
 * translated instead of needing a second FR/EN table in Rust.
 *
 * Commands whose feature has not shipped are listed with the phase they land
 * in, and appear disabled rather than absent: a Format menu that is missing
 * until Phase B reads as a broken app, while one that is greyed out reads as an
 * app under construction. `runAppCommand` refuses them with `not_supported`
 * rather than doing nothing quietly.
 *
 * *Calqo's `APP_COMMAND_IDS` is the pattern; the phase column is ours.*
 */
import { useEditorStore } from '@/lib/state/editorStore';
import { useUiStore } from '@/lib/state/uiStore';
import { createNoteCommand } from './noteCommands';
import { createCourseCommand } from './organizationCommands';
import { fail, ok, USER, type CommandContext, type CommandResult } from './types';
import {
  runEditorCommand,
  type EditorCommand,
} from '@/editor/commandBridge';

export const APP_COMMAND_IDS = [
  'app.settings',
  'note.new',
  'course.new',
  'note.save',
  'edit.find',
  'format.bold',
  'format.italic',
  'format.underline',
  'format.highlight',
  'format.code',
  'insert.image',
  'insert.drawing',
  'insert.table',
  'insert.callout',
  'insert.math',
  'insert.link',
  'view.toggleSidebar',
  'view.toggleInspector',
  'view.focusMode',
  'ai.rewrite',
  'ai.synthesize',
  'ai.mindMap',
  'ai.flashcards',
  'ai.podcast',
  'help.documentation',
] as const;

export type AppCommandId = (typeof APP_COMMAND_IDS)[number];

/** The phase a command becomes real. `A` means it works today. */
export type CommandPhase = 'A' | 'B' | 'C' | 'D' | 'E' | 'G' | 'H';

export interface AppCommand {
  id: AppCommandId;
  /** i18n key, resolved when the menu is built and again on a locale change. */
  labelKey: string;
  /** Tauri accelerator syntax. The web keybinding layer parses the same string,
   * so a shortcut is written once whichever shell is running. */
  accelerator?: string;
  landsIn: CommandPhase;
  run?(context: CommandContext): Promise<CommandResult<unknown>> | CommandResult<unknown>;
}

async function openNewNote(): Promise<CommandResult<unknown>> {
  const result = await createNoteCommand({});
  if (!result.ok) return result;
  // Select *and* open: a new note that does not land you in the editor is a
  // new note you have to go and find.
  useUiStore.getState().selectNote(result.value.id);
  await useEditorStore.getState().openNote(result.value.id);
  return result;
}

function editorAction(command: EditorCommand) {
  return async (): Promise<CommandResult<unknown>> =>
    (await runEditorCommand(command))
      ? ok(undefined)
      : fail('not_supported', 'Open a note to use editor commands');
}

export const APP_COMMANDS: Record<AppCommandId, AppCommand> = {
  'app.settings': {
    id: 'app.settings',
    labelKey: 'menu.settings',
    accelerator: 'CmdOrCtrl+,',
    landsIn: 'A',
    run: () => {
      useUiStore.getState().setSettingsOpen(true);
      return ok(undefined);
    },
  },
  'note.new': {
    id: 'note.new',
    labelKey: 'noteList.newNote',
    accelerator: 'CmdOrCtrl+N',
    landsIn: 'A',
    run: openNewNote,
  },
  'course.new': {
    id: 'course.new',
    labelKey: 'sidebar.newCourse',
    accelerator: 'CmdOrCtrl+Shift+N',
    landsIn: 'A',
    run: (context) => createCourseCommand({ name: newCourseName() }, context),
  },
  'note.save': {
    id: 'note.save',
    labelKey: 'menu.saveNow',
    accelerator: 'CmdOrCtrl+S',
    landsIn: 'A',
    // Autosave already owns saving; Cmd-S exists because a decade of muscle
    // memory says it must, and because flushing on demand before quitting or
    // exporting is genuinely useful.
    run: async () => {
      await useEditorStore.getState().flush();
      return ok(undefined);
    },
  },

  'edit.find': {
    id: 'edit.find',
    labelKey: 'menu.find',
    accelerator: 'CmdOrCtrl+F',
    landsIn: 'C',
  },

  'format.bold': {
    id: 'format.bold',
    labelKey: 'menu.bold',
    accelerator: 'CmdOrCtrl+B',
    landsIn: 'B',
    run: editorAction('bold'),
  },
  'format.italic': {
    id: 'format.italic',
    labelKey: 'menu.italic',
    accelerator: 'CmdOrCtrl+I',
    landsIn: 'B',
    run: editorAction('italic'),
  },
  'format.underline': {
    id: 'format.underline',
    labelKey: 'menu.underline',
    accelerator: 'CmdOrCtrl+U',
    landsIn: 'B',
    run: editorAction('underline'),
  },
  'format.highlight': {
    id: 'format.highlight',
    labelKey: 'menu.highlight',
    accelerator: 'CmdOrCtrl+Shift+H',
    landsIn: 'B',
    run: editorAction('highlight'),
  },
  'format.code': {
    id: 'format.code',
    labelKey: 'menu.code',
    accelerator: 'CmdOrCtrl+E',
    landsIn: 'B',
    run: editorAction('code'),
  },

  'insert.image': {
    id: 'insert.image',
    labelKey: 'menu.image',
    landsIn: 'B',
    run: editorAction('image'),
  },
  'insert.drawing': {
    id: 'insert.drawing',
    labelKey: 'menu.drawing',
    landsIn: 'B',
    run: editorAction('drawing'),
  },
  'insert.table': {
    id: 'insert.table',
    labelKey: 'menu.table',
    landsIn: 'B',
    run: editorAction('table'),
  },
  'insert.callout': {
    id: 'insert.callout',
    labelKey: 'menu.callout',
    landsIn: 'B',
    run: editorAction('callout'),
  },
  'insert.math': {
    id: 'insert.math',
    labelKey: 'menu.math',
    landsIn: 'B',
    run: editorAction('math'),
  },
  'insert.link': {
    id: 'insert.link',
    labelKey: 'menu.link',
    accelerator: 'CmdOrCtrl+K',
    landsIn: 'B',
    run: editorAction('link'),
  },

  'view.toggleSidebar': {
    id: 'view.toggleSidebar',
    labelKey: 'menu.toggleSidebar',
    accelerator: 'CmdOrCtrl+Alt+S',
    landsIn: 'A',
    run: () => {
      useUiStore.getState().toggleSidebar();
      return ok(undefined);
    },
  },
  'view.toggleInspector': {
    id: 'view.toggleInspector',
    labelKey: 'menu.toggleInspector',
    accelerator: 'CmdOrCtrl+Alt+I',
    landsIn: 'A',
    run: () => {
      useUiStore.getState().toggleInspector();
      return ok(undefined);
    },
  },
  'view.focusMode': {
    id: 'view.focusMode',
    labelKey: 'menu.focusMode',
    accelerator: 'CmdOrCtrl+Shift+F',
    landsIn: 'A',
    run: () => {
      const ui = useUiStore.getState();
      ui.setFocusMode(!ui.focusMode);
      return ok(undefined);
    },
  },

  'ai.rewrite': { id: 'ai.rewrite', labelKey: 'ai.rewrite', landsIn: 'E' },
  'ai.synthesize': { id: 'ai.synthesize', labelKey: 'ai.synthesis', landsIn: 'E' },
  'ai.mindMap': { id: 'ai.mindMap', labelKey: 'ai.mindMap', landsIn: 'G' },
  'ai.flashcards': { id: 'ai.flashcards', labelKey: 'ai.flashcards', landsIn: 'G' },
  'ai.podcast': { id: 'ai.podcast', labelKey: 'ai.podcast', landsIn: 'G' },

  'help.documentation': {
    id: 'help.documentation',
    labelKey: 'menu.documentation',
    landsIn: 'H',
  },
};

/** Set by the shell so command labels can be translated where they are used.
 * Defaults to the key itself, which is at least legible in a test. */
let translate: (key: string) => string = (key) => key;

export function setCommandTranslator(translator: (key: string) => string): void {
  translate = translator;
}

export function commandLabel(id: AppCommandId): string {
  return translate(APP_COMMANDS[id].labelKey);
}

function newCourseName(): string {
  return translate('sidebar.newCourse');
}

export function isCommandAvailable(id: AppCommandId): boolean {
  return APP_COMMANDS[id].run !== undefined;
}

/**
 * Run a command by id. The MCP bridge does not come through here — agents call
 * the note commands directly — but the menu, the keyboard, and the chrome all
 * do, which is what keeps one shortcut from behaving differently from the menu
 * item beside it.
 */
export async function runAppCommand(
  id: AppCommandId,
  context: CommandContext = USER,
): Promise<CommandResult<unknown>> {
  const command = APP_COMMANDS[id];
  if (!command.run) {
    return fail('not_supported', `${id} lands in phase ${command.landsIn}`);
  }
  return command.run(context);
}

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

interface Accelerator {
  key: string;
  meta: boolean;
  shift: boolean;
  alt: boolean;
}

/** Parse Tauri accelerator syntax. `CmdOrCtrl` maps to the platform's own
 * modifier, which on the only platform we ship is Command. */
function parseAccelerator(accelerator: string): Accelerator {
  const parts = accelerator.split('+');
  const key = parts[parts.length - 1] ?? '';
  const modifiers = parts.slice(0, -1).map((part) => part.toLowerCase());
  return {
    key: key.toLowerCase(),
    meta: modifiers.includes('cmdorctrl') || modifiers.includes('cmd'),
    shift: modifiers.includes('shift'),
    alt: modifiers.includes('alt') || modifiers.includes('option'),
  };
}

function matches(event: KeyboardEvent, accelerator: Accelerator): boolean {
  // `event.key` is the *produced* character, so Alt-S on macOS arrives as "ß".
  // `event.code` is the physical key, which is what an accelerator names.
  const pressed =
    accelerator.key.length === 1 && /[a-z]/.test(accelerator.key)
      ? event.code === `Key${accelerator.key.toUpperCase()}`
      : event.key.toLowerCase() === accelerator.key;

  const primary = event.metaKey || event.ctrlKey;
  return (
    pressed &&
    primary === accelerator.meta &&
    event.shiftKey === accelerator.shift &&
    event.altKey === accelerator.alt
  );
}

/**
 * Bind every command's accelerator to the window.
 *
 * Only for shells without a native menu bar — under macOS the menu owns these
 * key combinations, and binding them here too would run each command twice.
 * Returns an unsubscribe function.
 */
export function bindCommandKeys(): () => void {
  const bindings = APP_COMMAND_IDS.filter((id) => APP_COMMANDS[id].accelerator).map((id) => ({
    id,
    accelerator: parseAccelerator(APP_COMMANDS[id].accelerator!),
  }));

  const onKeyDown = (event: KeyboardEvent) => {
    for (const binding of bindings) {
      if (!matches(event, binding.accelerator)) continue;
      if (!isCommandAvailable(binding.id)) continue;
      event.preventDefault();
      void runAppCommand(binding.id);
      return;
    }
  };

  window.addEventListener('keydown', onKeyDown);
  return () => window.removeEventListener('keydown', onKeyDown);
}
