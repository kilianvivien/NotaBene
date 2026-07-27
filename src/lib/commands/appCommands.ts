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
import { useSpeechStore } from '@/lib/state/speechStore';
import { useUiStore } from '@/lib/state/uiStore';
import { createNoteCommand } from './noteCommands';
import { createCourseCommand } from './organizationCommands';
import { fail, ok, USER, type CommandContext, type CommandResult } from './types';
import { runEditorCommand, type EditorCommand } from '@/editor/commandBridge';

export const APP_COMMAND_IDS = [
  'app.commandPalette',
  'app.settings',
  'note.new',
  'note.quick',
  'note.newFromTemplate',
  'course.new',
  'note.save',
  'note.export',
  'backup.create',
  'backup.restore',
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
  'note.readAloud',
  'view.toggleSidebar',
  'view.toggleInspector',
  'view.focusMode',
  'ai.rewrite',
  'ai.synthesize',
  'ai.ask',
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
  const view = useUiStore.getState().view;
  const location =
    view.kind === 'course'
      ? { courseId: view.courseId, sectionId: view.sectionId ?? null }
      : {};
  const result = await createNoteCommand(location);
  if (!result.ok) return result;
  // Select *and* open: a new note that does not land you in the editor is a
  // new note you have to go and find.
  useUiStore.getState().selectNote(result.value.id);
  await useEditorStore.getState().openNote(result.value.id);
  return result;
}

async function openQuickNote(): Promise<CommandResult<unknown>> {
  const result = await createNoteCommand({
    title: translate('noteList.quickNoteTitle'),
    courseId: null,
    sectionId: null,
  });
  if (!result.ok) return result;
  useUiStore.getState().setView({ kind: 'inbox' });
  useUiStore.getState().selectNote(result.value.id);
  await useEditorStore.getState().openNote(result.value.id);
  return result;
}

/** AI actions all need something to work on. Refusing with a named reason beats
 * opening a dialog that can only say "no note selected". */
function requireNote(open: () => void) {
  return (): CommandResult<unknown> => {
    if (!useEditorStore.getState().note) {
      return fail('not_found', 'open a note first');
    }
    open();
    return ok(undefined);
  };
}

function editorAction(command: EditorCommand) {
  return async (): Promise<CommandResult<unknown>> =>
    (await runEditorCommand(command))
      ? ok(undefined)
      : fail('not_supported', 'Open a note to use editor commands');
}

export const APP_COMMANDS: Record<AppCommandId, AppCommand> = {
  /**
   * One field for "find a note" and "do a thing".
   *
   * ⌘K, because that is where a student's hands already go. It is the only
   * command that must never be unavailable — a palette that cannot open is a
   * palette nobody learns to trust — so it has no note or provider precondition.
   */
  'app.commandPalette': {
    id: 'app.commandPalette',
    labelKey: 'menu.commandPalette',
    accelerator: 'CmdOrCtrl+K',
    landsIn: 'A',
    run: () => {
      useUiStore.getState().setCommandPaletteOpen(true);
      return ok(undefined);
    },
  },
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
  'note.quick': {
    id: 'note.quick',
    labelKey: 'noteList.quickNote',
    accelerator: 'CmdOrCtrl+Shift+Q',
    landsIn: 'C',
    run: openQuickNote,
  },
  'note.newFromTemplate': {
    id: 'note.newFromTemplate',
    labelKey: 'organization.newFromTemplate',
    accelerator: 'CmdOrCtrl+Alt+N',
    landsIn: 'C',
    run: () => {
      useUiStore.getState().setTemplatePickerOpen(true);
      return ok(undefined);
    },
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
  'note.export': {
    id: 'note.export',
    labelKey: 'menu.export',
    accelerator: 'CmdOrCtrl+Shift+E',
    landsIn: 'D',
    run: () => {
      useUiStore.getState().setExportOpen(true);
      return ok(undefined);
    },
  },
  'backup.create': {
    id: 'backup.create',
    labelKey: 'menu.backupNow',
    accelerator: 'CmdOrCtrl+Shift+B',
    landsIn: 'D',
    run: () => {
      useUiStore.getState().setSettingsTab('backups');
      useUiStore.getState().setSettingsOpen(true);
      return ok(undefined);
    },
  },
  'backup.restore': {
    id: 'backup.restore',
    labelKey: 'menu.restoreBackup',
    accelerator: 'CmdOrCtrl+Alt+B',
    landsIn: 'D',
    run: () => {
      useUiStore.getState().setSettingsTab('backups');
      useUiStore.getState().setSettingsOpen(true);
      return ok(undefined);
    },
  },

  'edit.find': {
    id: 'edit.find',
    labelKey: 'menu.find',
    accelerator: 'CmdOrCtrl+F',
    landsIn: 'C',
    run: editorAction('find'),
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
    accelerator: 'CmdOrCtrl+Shift+I',
    landsIn: 'B',
    run: editorAction('image'),
  },
  'insert.drawing': {
    id: 'insert.drawing',
    labelKey: 'menu.drawing',
    accelerator: 'CmdOrCtrl+Shift+D',
    landsIn: 'B',
    run: editorAction('drawing'),
  },
  'insert.table': {
    id: 'insert.table',
    labelKey: 'menu.table',
    accelerator: 'CmdOrCtrl+Shift+T',
    landsIn: 'B',
    run: editorAction('table'),
  },
  'insert.callout': {
    id: 'insert.callout',
    labelKey: 'menu.callout',
    accelerator: 'CmdOrCtrl+Shift+C',
    landsIn: 'B',
    run: editorAction('callout'),
  },
  'insert.math': {
    id: 'insert.math',
    labelKey: 'menu.math',
    accelerator: 'CmdOrCtrl+Shift+M',
    landsIn: 'B',
    run: editorAction('math'),
  },
  'insert.link': {
    id: 'insert.link',
    labelKey: 'menu.link',
    // ⌘K is the command palette, as it is nearly everywhere else now.
    accelerator: 'CmdOrCtrl+Shift+K',
    landsIn: 'B',
    run: editorAction('link'),
  },

  /**
   * Speak the open note.
   *
   * In the File-adjacent part of the table rather than under AI, because no
   * provider is involved: this is the note's own words through a macOS voice.
   * Pressing it while it is speaking stops it, which is what makes one shortcut
   * enough.
   */
  'note.readAloud': {
    id: 'note.readAloud',
    labelKey: 'menu.readAloud',
    accelerator: 'CmdOrCtrl+Shift+L',
    landsIn: 'G',
    run: async () => {
      const speech = useSpeechStore.getState();
      if (speech.status !== 'idle') {
        speech.stop();
        return ok(undefined);
      }
      const note = useEditorStore.getState().note;
      if (!note) return fail('not_found', 'open a note first');
      await speech.speak(note.plainText);
      return ok(undefined);
    },
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

  'ai.rewrite': {
    id: 'ai.rewrite',
    labelKey: 'ai.rewrite',
    accelerator: 'CmdOrCtrl+Shift+R',
    landsIn: 'E',
    run: requireNote(() => {
      useUiStore.getState().setAiRewriteOpen(true);
    }),
  },
  'ai.synthesize': {
    id: 'ai.synthesize',
    labelKey: 'ai.synthesis',
    accelerator: 'CmdOrCtrl+Shift+S',
    landsIn: 'E',
    run: requireNote(() => {
      useUiStore.getState().setAiSynthesisOpen(true);
    }),
  },
  'ai.ask': {
    id: 'ai.ask',
    labelKey: 'ai.ask',
    accelerator: 'CmdOrCtrl+Shift+A',
    landsIn: 'E',
    run: requireNote(() => {
      // The Ask panel is a tab, not a modal: the question is usually about the
      // paragraph you are looking at, and a dialog over the note would hide it.
      useUiStore.getState().setInspectorTab('ai');
    }),
  },
  'ai.mindMap': {
    id: 'ai.mindMap',
    labelKey: 'ai.mindMap',
    accelerator: 'CmdOrCtrl+Shift+G',
    landsIn: 'G',
    run: requireNote(() => {
      useUiStore.getState().setAiMindMapOpen(true);
    }),
  },
  'ai.flashcards': {
    id: 'ai.flashcards',
    labelKey: 'ai.flashcards',
    accelerator: 'CmdOrCtrl+Alt+F',
    landsIn: 'G',
    run: requireNote(() => {
      useUiStore.getState().setAiFlashcardsOpen(true);
    }),
  },
  'ai.podcast': {
    id: 'ai.podcast',
    labelKey: 'ai.podcast',
    accelerator: 'CmdOrCtrl+Alt+P',
    landsIn: 'G',
    run: requireNote(() => {
      useUiStore.getState().setAiPodcastOpen(true);
    }),
  },

  'help.documentation': {
    id: 'help.documentation',
    labelKey: 'menu.documentation',
    accelerator: 'CmdOrCtrl+Shift+Slash',
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

/**
 * Tauri's names for keys that are not a letter, mapped to what a
 * `KeyboardEvent` actually reports. The native menu wants `Slash`; the webview
 * reports `/`, and without this the web keybinding layer silently never fires.
 */
const KEY_NAMES: Record<string, string> = {
  slash: '/',
  comma: ',',
  period: '.',
  minus: '-',
  plus: '+',
  equal: '=',
  space: ' ',
};

/** Parse Tauri accelerator syntax. `CmdOrCtrl` maps to the platform's own
 * modifier, which on the only platform we ship is Command. */
function parseAccelerator(accelerator: string): Accelerator {
  const parts = accelerator.split('+');
  const raw = (parts[parts.length - 1] ?? '').toLowerCase();
  const key = KEY_NAMES[raw] ?? raw;
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
  const bindings = APP_COMMAND_IDS.filter((id) => APP_COMMANDS[id].accelerator).map(
    (id) => ({
      id,
      accelerator: parseAccelerator(APP_COMMANDS[id].accelerator!),
    }),
  );

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
