/** File pickers and confirmations. Native under Tauri, DOM in the browser. */
export interface FileFilter {
  name: string;
  extensions: string[];
}

export interface DialogAdapter {
  openFile(options?: { filters?: FileFilter[]; multiple?: boolean }): Promise<string[]>;
  openFolder(): Promise<string | null>;
  saveFile(options?: {
    defaultPath?: string;
    filters?: FileFilter[];
  }): Promise<string | null>;
  confirm(message: string, options?: { title?: string; danger?: boolean }): Promise<boolean>;
}
