/**
 * The native application menu.
 *
 * The shell owns the `NSMenu`; the app owns what is in it. This interface is
 * the seam: the app hands over a description and gets clicks back as command
 * ids. A browser build simply has no menu bar, and its implementation says so
 * by doing nothing — the same commands are still reachable by keyboard and by
 * the chrome.
 */

/** A system role, wired by the OS rather than by us. Cmd-C has to be a real
 * `NSMenuItem` with the copy role or it will not reach a focused text field. */
export type MenuRole =
  | 'about'
  | 'services'
  | 'hide'
  | 'hideOthers'
  | 'showAll'
  | 'quit'
  | 'undo'
  | 'redo'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'selectAll'
  | 'minimize'
  | 'maximize'
  | 'fullscreen'
  | 'closeWindow'
  | 'bringAllToFront';

export type MenuNode =
  | {
      kind: 'item';
      /** An `AppCommandId`. Typed as a string here so the adapter layer does
       * not have to know the command table. */
      id: string;
      label: string;
      accelerator?: string;
      enabled?: boolean;
    }
  | { kind: 'predefined'; role: MenuRole; label?: string }
  | { kind: 'separator' }
  | { kind: 'submenu'; label: string; items: MenuNode[] };

export interface MenuAdapter {
  /** Replace the menu bar. Called at startup and after a locale change. */
  apply(menu: MenuNode[]): Promise<void>;
  /** Subscribe to menu clicks; resolves to an unsubscribe function. */
  onCommand(handler: (commandId: string) => void): Promise<() => void>;
}
