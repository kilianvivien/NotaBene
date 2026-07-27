/** Which shell are we running in, and what can it do? Detected once at module
 * load — the answer cannot change during a session. */
interface TauriGlobals {
  isTauri?: boolean;
  __TAURI_INTERNALS__?: unknown;
}

export interface PlatformCapabilities {
  nativeFileDialogs: boolean;
  nativeMenus: boolean;
  /** Keychain-backed secret storage. */
  secureSecrets: boolean;
  /** Real PDF printing and DOCX writing to a chosen path. */
  fileExports: boolean;
  /** The embedded loopback MCP server. */
  mcpServer: boolean;
  /** AVSpeechSynthesizer / Voxtral. */
  textToSpeech: boolean;
  systemClipboardImages: boolean;
  fileDrops: boolean;
}

export interface PlatformRuntime {
  kind: 'browser' | 'tauri';
  capabilities: PlatformCapabilities;
}

function hasTauriInternals(): boolean {
  return (
    typeof globalThis !== 'undefined' &&
    (Boolean((globalThis as typeof globalThis & TauriGlobals).isTauri) ||
      Boolean((globalThis as typeof globalThis & TauriGlobals).__TAURI_INTERNALS__))
  );
}

export function detectPlatformRuntime(): PlatformRuntime {
  return hasTauriInternals()
    ? {
        kind: 'tauri',
        capabilities: {
          nativeFileDialogs: true,
          nativeMenus: true,
          secureSecrets: true,
          fileExports: true,
          mcpServer: true,
          textToSpeech: true,
          systemClipboardImages: true,
          fileDrops: true,
        },
      }
    : {
        kind: 'browser',
        capabilities: {
          nativeFileDialogs: false,
          nativeMenus: false,
          secureSecrets: false,
          fileExports: false,
          mcpServer: false,
          textToSpeech: false,
          systemClipboardImages: false,
          fileDrops: false,
        },
      };
}

export const platformRuntime: PlatformRuntime = detectPlatformRuntime();

export const isTauri = platformRuntime.kind === 'tauri';
