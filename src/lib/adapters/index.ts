/**
 * Active adapter implementations.
 *
 * The rest of the app imports these interface-typed singletons and nothing
 * else from `adapters/`. That is the whole trick behind the web-ready core: a
 * future browser build changes this file and only this file (PRD §7.2).
 *
 * House rule, enforced by review: no file outside `src/lib/adapters/` may
 * import `@tauri-apps/*`.
 */
import { memoryLibraryAdapter } from './library/memoryLibraryAdapter';
import { tauriLibraryAdapter } from './library/tauriLibraryAdapter';
import { memoryAssetAdapter } from './assets/memoryAssetAdapter';
import { tauriAssetAdapter } from './assets/tauriAssetAdapter';
import { memorySecretsAdapter, memorySettingsAdapter } from './settings/memorySettingsAdapter';
import { tauriSecretsAdapter, tauriSettingsAdapter } from './settings/tauriSettingsAdapter';
import { browserDialogAdapter } from './dialog/browserDialogAdapter';
import { tauriDialogAdapter } from './dialog/tauriDialogAdapter';
import { browserExportAdapter } from './export/browserExportAdapter';
import { tauriExportAdapter } from './export/tauriExportAdapter';
import { tauriMenuAdapter, unavailableMenuAdapter } from './menu/tauriMenuAdapter';
import { fetchAiTransport } from './ai/fetchAiTransport';
import { tauriAiTransport } from './ai/tauriAiTransport';
import { systemTtsEngine, unavailableTtsEngine } from './tts/systemTtsEngine';
import { tauriMcpAdapter, unavailableMcpAdapter } from './mcp/tauriMcpAdapter';
import { isTauri } from '@/lib/platform/runtime';

import type { LibraryAdapter } from './library/LibraryAdapter';
import type { AssetAdapter } from './assets/AssetAdapter';
import type { SecretsAdapter, SettingsAdapter } from './settings/SettingsAdapter';
import type { DialogAdapter } from './dialog/DialogAdapter';
import type { ExportAdapter } from './export/ExportAdapter';
import type { MenuAdapter } from './menu/MenuAdapter';
import type { AiTransport } from './ai/AiTransport';
import type { TtsEngine } from './tts/TtsEngine';
import type { McpAdapter } from './mcp/McpAdapter';

export const library: LibraryAdapter = isTauri ? tauriLibraryAdapter : memoryLibraryAdapter;
export const assets: AssetAdapter = isTauri ? tauriAssetAdapter : memoryAssetAdapter;
export const appSettings: SettingsAdapter = isTauri
  ? tauriSettingsAdapter
  : memorySettingsAdapter;
export const secrets: SecretsAdapter = isTauri ? tauriSecretsAdapter : memorySecretsAdapter;
export const dialog: DialogAdapter = isTauri ? tauriDialogAdapter : browserDialogAdapter;
export const exporter: ExportAdapter = isTauri ? tauriExportAdapter : browserExportAdapter;
export const mcp: McpAdapter = isTauri ? tauriMcpAdapter : unavailableMcpAdapter;
export const appMenu: MenuAdapter = isTauri ? tauriMenuAdapter : unavailableMenuAdapter;
// Desktop AI leaves through Rust so that a self-hosted or otherwise unusual
// base URL does not require widening `connect-src` for the whole webview; the
// browser build has no such escape hatch and uses `fetch` (plan §E risk 2).
export const aiTransport: AiTransport = isTauri ? tauriAiTransport : fetchAiTransport;
export const tts: TtsEngine = isTauri ? systemTtsEngine : unavailableTtsEngine;

export type {
  LibraryAdapter,
  NoteQuery,
  SnapshotRetentionPolicy,
} from './library/LibraryAdapter';
export type { AssetAdapter } from './assets/AssetAdapter';
export type {
  AccentColor,
  AiProviderSettings,
  AppSettings,
  PodcastSettings,
  SecretsAdapter,
  SettingsAdapter,
} from './settings/SettingsAdapter';
export { DEFAULT_SETTINGS } from './settings/SettingsAdapter';
export type { DialogAdapter, FileFilter } from './dialog/DialogAdapter';
export type {
  ExportAdapter,
  ExportFile,
  ExportFormat,
  ExportRequest,
  ExportResult,
  NoteExportFormat,
} from './export/ExportAdapter';
export type { MenuAdapter, MenuNode, MenuRole } from './menu/MenuAdapter';
export type { AiRequest, AiResponse, AiTransport } from './ai/AiTransport';
export type { TtsEngine, TtsRequest, TtsVoice } from './tts/TtsEngine';
export type {
  McpAdapter,
  McpBridgeRequest,
  McpClientId,
  McpStatus,
} from './mcp/McpAdapter';
