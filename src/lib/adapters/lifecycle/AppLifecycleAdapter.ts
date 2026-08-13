/** Process-level actions kept behind the same desktop boundary as every other
 * Tauri API. */
export interface AppLifecycleAdapter {
  relaunch(): Promise<void>;
}
