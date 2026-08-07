/**
 * The application window itself.
 *
 * Concentration mode is the only thing that needs this: taking the whole screen
 * is what finally gets macOS to hide its own chrome — the traffic lights are
 * drawn by the OS over our overlay title bar, so no amount of CSS can retreat
 * them. Everything else about the window is the OS's business.
 */
export interface WindowAdapter {
  setFullscreen(on: boolean): Promise<void>;
  isFullscreen(): Promise<boolean>;
  /**
   * Report entering and leaving fullscreen, however it happened — the green
   * button and `⌃⌘F` are not ours, and the layout that reclaims the title bar's
   * band has to follow the window rather than our own flag. Returns the
   * unsubscribe.
   */
  onFullscreenChange(listener: (fullscreen: boolean) => void): Promise<() => void>;
}
