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
import {
  memorySecretsAdapter,
  memorySettingsAdapter,
} from './settings/memorySettingsAdapter';
import {
  tauriSecretsAdapter,
  tauriSettingsAdapter,
} from './settings/tauriSettingsAdapter';
import { browserDialogAdapter } from './dialog/browserDialogAdapter';
import { tauriDialogAdapter } from './dialog/tauriDialogAdapter';
import { browserExportAdapter } from './export/browserExportAdapter';
import { tauriExportAdapter } from './export/tauriExportAdapter';
import { tauriMenuAdapter, unavailableMenuAdapter } from './menu/tauriMenuAdapter';
import { fetchAiTransport } from './ai/fetchAiTransport';
import { tauriAiTransport } from './ai/tauriAiTransport';
import { systemTtsEngine, unavailableTtsEngine } from './tts/systemTtsEngine';
import { createMistralTtsEngine } from './tts/mistralTtsEngine';
import { createGeminiTtsEngine } from './tts/geminiTtsEngine';
import { createTtsEngineRegistry } from './tts/ttsEngineRegistry';
import { createLocalTtsEngine, unavailableLocalTtsEngine } from './tts/localTtsEngines';
import { tauriMcpAdapter, unavailableMcpAdapter } from './mcp/tauriMcpAdapter';
import { browserExternalLinkAdapter } from './external/browserExternalLinkAdapter';
import { tauriExternalLinkAdapter } from './external/tauriExternalLinkAdapter';
import { browserWindowAdapter } from './window/browserWindowAdapter';
import { tauriWindowAdapter } from './window/tauriWindowAdapter';
import { isTauri } from '@/lib/platform/runtime';

import type { LibraryAdapter } from './library/LibraryAdapter';
import type { AssetAdapter } from './assets/AssetAdapter';
import type { SecretsAdapter, SettingsAdapter } from './settings/SettingsAdapter';
import type { DialogAdapter } from './dialog/DialogAdapter';
import type { ExportAdapter } from './export/ExportAdapter';
import type { MenuAdapter } from './menu/MenuAdapter';
import type { AiTransport } from './ai/AiTransport';
import type { McpAdapter } from './mcp/McpAdapter';
import type { ExternalLinkAdapter } from './external/ExternalLinkAdapter';
import type { WindowAdapter } from './window/WindowAdapter';

export const library: LibraryAdapter = isTauri
  ? tauriLibraryAdapter
  : memoryLibraryAdapter;
export const assets: AssetAdapter = isTauri ? tauriAssetAdapter : memoryAssetAdapter;
export const appSettings: SettingsAdapter = isTauri
  ? tauriSettingsAdapter
  : memorySettingsAdapter;
export const secrets: SecretsAdapter = isTauri
  ? tauriSecretsAdapter
  : memorySecretsAdapter;
export const dialog: DialogAdapter = isTauri ? tauriDialogAdapter : browserDialogAdapter;
export const exporter: ExportAdapter = isTauri
  ? tauriExportAdapter
  : browserExportAdapter;
export const mcp: McpAdapter = isTauri ? tauriMcpAdapter : unavailableMcpAdapter;
export const appMenu: MenuAdapter = isTauri ? tauriMenuAdapter : unavailableMenuAdapter;
export const externalLinks: ExternalLinkAdapter = isTauri
  ? tauriExternalLinkAdapter
  : browserExternalLinkAdapter;
export const appWindow: WindowAdapter = isTauri
  ? tauriWindowAdapter
  : browserWindowAdapter;
// Desktop AI leaves through Rust so that a self-hosted or otherwise unusual
// base URL does not require widening `connect-src` for the whole webview; the
// browser build has no such escape hatch and uses `fetch` (plan §E risk 2).
export const aiTransport: AiTransport = isTauri ? tauriAiTransport : fetchAiTransport;
const activeSystemTtsEngine = isTauri ? systemTtsEngine : unavailableTtsEngine;
const voxtralTtsEngine = isTauri
  ? createLocalTtsEngine('voxtral-local')
  : unavailableLocalTtsEngine('voxtral-local');
const kokoroTtsEngine = isTauri
  ? createLocalTtsEngine('kokoro-local')
  : unavailableLocalTtsEngine('kokoro-local');
const mistralTtsEngine = createMistralTtsEngine(aiTransport, secrets);
const geminiTtsEngine = createGeminiTtsEngine(aiTransport, secrets);
export const ttsRegistry = createTtsEngineRegistry(
  activeSystemTtsEngine,
  voxtralTtsEngine,
  kokoroTtsEngine,
  mistralTtsEngine,
  geminiTtsEngine,
);
/** Compatibility alias while callers migrate to the registry. */
export const tts = activeSystemTtsEngine;

export type {
  LibraryAdapter,
  NoteQuery,
  SnapshotRetentionPolicy,
} from './library/LibraryAdapter';
export type { AssetAdapter } from './assets/AssetAdapter';
export type {
  Abbreviation,
  AccentColor,
  AiProviderSettings,
  AppSettings,
  FocusSettings,
  PodcastSettings,
  SpeechSettings,
  SecretsAdapter,
  SettingsAdapter,
} from './settings/SettingsAdapter';
export { DEFAULT_SETTINGS } from './settings/SettingsAdapter';
export {
  LOCAL_MODEL_REVISIONS,
  localTtsModels,
  type LocalModelStatus,
  type ManagedLocalEngineId,
} from './tts/localTtsEngines';
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
export type { ExternalLinkAdapter } from './external/ExternalLinkAdapter';
export type { WindowAdapter } from './window/WindowAdapter';
export type {
  TtsAudioEncoding,
  TtsEngine,
  TtsEngineCapabilities,
  TtsEngineId,
  TtsEngineRegistry,
  TtsEngineState,
  TtsEngineSummary,
  TtsRequest,
  TtsSegmentResult,
  TtsVoice,
} from './tts/TtsEngine';
export type {
  McpAdapter,
  McpBridgeRequest,
  McpClientDefinition,
  McpClientId,
  McpStatus,
} from './mcp/McpAdapter';
export { MCP_CLIENTS } from './mcp/McpAdapter';
