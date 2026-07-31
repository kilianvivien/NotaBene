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
}
