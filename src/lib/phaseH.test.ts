import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Blob as NodeBlob } from 'node:buffer';
import en from '@/locales/en/common.json';
import fr from '@/locales/fr/common.json';
import { memoryLibraryAdapter } from '@/lib/adapters/library/memoryLibraryAdapter';
import { resetMemorySettings } from '@/lib/adapters/settings/memorySettingsAdapter';
import { DEFAULT_SETTINGS } from '@/lib/adapters';
import {
  addAttachmentCommand,
  attachPodcastAudioCommand,
  encodePodcastMp3Bytes,
  runOnboardingCommand,
  saveAttachmentCommand,
} from '@/lib/commands';
import { mindMapOutline, reparentMindMap, visibleMindMap } from '@/lib/mindmap/edit';
import { encodeWav } from '@/lib/podcast/wav';
import type { MindMap } from '@/lib/schema';
import { useSettingsStore } from '@/lib/state/settingsStore';

function keys(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object') return [prefix];
  return Object.entries(value).flatMap(([key, child]) =>
    keys(child, prefix ? `${prefix}.${key}` : key),
  );
}

const map: MindMap = {
  title: 'Limits',
  nodes: [
    { id: 'root', label: 'Limits' },
    { id: 'left', label: 'Left-hand limit' },
    { id: 'example', label: 'Example', note: 'Approach from below' },
    { id: 'right', label: 'Right-hand limit' },
  ],
  edges: [
    { from: 'root', to: 'left' },
    { from: 'left', to: 'example' },
    { from: 'root', to: 'right' },
  ],
};

beforeEach(() => {
  memoryLibraryAdapter.reset();
  resetMemorySettings();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS, loaded: true });
});

describe('Phase H release invariants', () => {
  it('keeps the web and desktop package versions identical', () => {
    const packageVersion = JSON.parse(
      readFileSync(`${process.cwd()}/package.json`, 'utf8'),
    ).version;
    const tauriVersion = JSON.parse(
      readFileSync(`${process.cwd()}/src-tauri/tauri.conf.json`, 'utf8'),
    ).version;
    const cargo = readFileSync(`${process.cwd()}/src-tauri/Cargo.toml`, 'utf8');
    expect(tauriVersion).toBe(packageVersion);
    expect(cargo).toMatch(new RegExp(`^version = "${packageVersion}"$`, 'm'));
  });

  it('allows the bundled MP3 encoder without enabling general JavaScript eval', () => {
    const tauri = JSON.parse(
      readFileSync(`${process.cwd()}/src-tauri/tauri.conf.json`, 'utf8'),
    );
    const csp = String(tauri.app.security.csp);
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(csp).not.toContain("'unsafe-eval'");
  });

  it('keeps every English and French translation key in parity', () => {
    expect(keys(fr).sort()).toEqual(keys(en).sort());
  });

  it('creates starter content exactly once', async () => {
    const first = await Promise.all([runOnboardingCommand(), runOnboardingCommand()]);
    expect(first.every((result) => result.ok)).toBe(true);
    expect(await memoryLibraryAdapter.listCourses()).toHaveLength(1);
    expect(await memoryLibraryAdapter.queryNotes({ scope: 'live' })).toHaveLength(2);

    await runOnboardingCommand();
    expect(await memoryLibraryAdapter.listCourses()).toHaveLength(1);
  });

  it('collapses a branch without deleting its source data', () => {
    const visible = visibleMindMap(map, ['left']);
    expect(visible.nodes.map((node) => node.id)).not.toContain('example');
    expect(map.nodes.map((node) => node.id)).toContain('example');
  });

  it('reparents safely and exports a readable Markdown outline', () => {
    const moved = reparentMindMap(map, 'example', 'right');
    expect(moved.edges).toContainEqual({ from: 'right', to: 'example' });
    expect(reparentMindMap(moved, 'right', 'example')).toEqual(moved);
    expect(mindMapOutline(moved)).toContain('  - Right-hand limit');
    expect(mindMapOutline(moved)).toContain('    - Example — Approach from below');
  });

  it('encodes joined podcast PCM as a real MP3 locally', async () => {
    const samples = new Uint8Array((22_050 / 5) * 2);
    const wav = encodeWav({
      format: { sampleRate: 22_050, channels: 1, bitsPerSample: 16 },
      samples,
    });
    const bytes = await encodePodcastMp3Bytes([
      {
        audio: new NodeBlob([wav], { type: 'audio/wav' }) as unknown as Blob,
        durationMs: 200,
      },
    ]);
    expect(bytes.length).toBeGreaterThan(100);
    expect(
      (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) ||
        (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0),
    ).toBe(true);
  });

  it('keeps a generated podcast as a playable note attachment', async () => {
    const note = memoryLibraryAdapter.seedNote({ title: 'Thermodynamics' });
    const wav = encodeWav({
      format: { sampleRate: 22_050, channels: 1, bitsPerSample: 16 },
      samples: new Uint8Array((22_050 / 5) * 2),
    });
    const outcome = await attachPodcastAudioCommand(
      note.id,
      {
        title: 'Heat and temperature',
        mode: 'narrator',
        segments: [{ speaker: 'narrator', text: 'Heat moves between systems.' }],
      },
      [
        {
          audio: new NodeBlob([wav], { type: 'audio/wav' }) as unknown as Blob,
          durationMs: 200,
        },
      ],
    );

    expect(outcome.ok).toBe(true);
    const attachments = await memoryLibraryAdapter.listAttachments(note.id);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.name).toBe('heat-and-temperature.mp3');
  });

  it('saves an attachment with its original name and bytes', async () => {
    const note = memoryLibraryAdapter.seedNote({ title: 'Reference image' });
    const added = await addAttachmentCommand(
      note.id,
      new File([new Uint8Array([1, 2, 3])], 'diagram.png', { type: 'image/png' }),
    );
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    const originalCreateObjectUrl = URL.createObjectURL;
    const originalRevokeObjectUrl = URL.revokeObjectURL;
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:attachment-export'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);

    try {
      const saved = await saveAttachmentCommand(added.value, 'diagram.png');
      expect(saved.ok).toBe(true);
      expect(click).toHaveBeenCalledOnce();
    } finally {
      click.mockRestore();
      Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        value: originalCreateObjectUrl,
      });
      Object.defineProperty(URL, 'revokeObjectURL', {
        configurable: true,
        value: originalRevokeObjectUrl,
      });
    }
  });

  it('rejects attachment types that have no in-app preview', async () => {
    const note = memoryLibraryAdapter.seedNote({ title: 'Safe attachments' });
    const outcome = await addAttachmentCommand(
      note.id,
      new File(['binary'], 'archive.zip', { type: 'application/zip' }),
    );

    expect(outcome).toMatchObject({
      ok: false,
      code: 'invalid_input',
      message: 'unsupported attachment format',
    });
    expect(await memoryLibraryAdapter.listAttachments(note.id)).toHaveLength(0);
  });
});
