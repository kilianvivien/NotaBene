import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GlassButton, ModalOverlay } from '@/components/glass';
import { exportNotesCommand } from '@/lib/commands';
import { useLibraryStore } from '@/lib/state/libraryStore';
import { useSettingsStore } from '@/lib/state/settingsStore';
import { useUiStore } from '@/lib/state/uiStore';
import type { AppSettings } from '@/lib/adapters';

export function ExportDialog() {
  const { t, i18n } = useTranslation();
  const open = useUiStore((state) => state.exportOpen);
  const setOpen = useUiStore((state) => state.setExportOpen);
  const selected = useUiStore((state) => state.selectedNoteId);
  const multiSelection = useUiStore((state) => state.multiSelection);
  const visibleNotes = useLibraryStore((state) => state.notes);
  const preset = useSettingsStore((state) => state.settings.exportPreset);
  const updateSettings = useSettingsStore((state) => state.update);
  const [scope, setScope] = useState<'selected' | 'view'>('selected');
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState('');

  const ids =
    scope === 'view'
      ? visibleNotes.map((note) => note.id)
      : multiSelection.length
        ? multiSelection
        : selected
          ? [selected]
          : [];

  function setPreset(patch: Partial<AppSettings['exportPreset']>) {
    void updateSettings({ exportPreset: { ...preset, ...patch } });
  }

  async function run() {
    setWorking(true);
    setMessage('');
    const result = await exportNotesCommand(ids, {
      ...preset,
      layout: preset.format === 'pdf' ? 'combined' : preset.layout,
      language: i18n.language,
    });
    setWorking(false);
    if (result.ok) {
      setMessage(t('export.complete'));
    } else if (result.code !== 'not_supported') {
      setMessage(result.message);
    }
  }

  return (
    <ModalOverlay open={open} onClose={() => setOpen(false)} label={t('export.title')}>
      <div className="w-[460px] p-5">
        <h2 className="text-[17px] font-semibold">{t('export.title')}</h2>
        <div className="mt-4 space-y-4">
          <label className="flex items-center justify-between gap-4 text-[13px]">
            {t('export.notes')}
            <select
              value={scope}
              onChange={(event) => setScope(event.target.value as typeof scope)}
              className="h-8 rounded-nb-xs border border-[var(--nb-control-border)] bg-[var(--nb-control-surface)] px-2"
            >
              <option value="selected">{t('export.selectedNotes')}</option>
              <option value="view">{t('export.currentView')}</option>
            </select>
          </label>
          <label className="flex items-center justify-between gap-4 text-[13px]">
            {t('export.format')}
            <select
              value={preset.format}
              onChange={(event) =>
                setPreset({
                  format: event.target.value as AppSettings['exportPreset']['format'],
                })
              }
              className="h-8 rounded-nb-xs border border-[var(--nb-control-border)] bg-[var(--nb-control-surface)] px-2"
            >
              <option value="markdown">Markdown</option>
              <option value="html">HTML</option>
              <option value="pdf">PDF</option>
              <option value="docx">DOCX</option>
            </select>
          </label>
          <label className="flex items-center justify-between gap-4 text-[13px]">
            {t('export.layout')}
            <select
              value={preset.format === 'pdf' ? 'combined' : preset.layout}
              disabled={preset.format === 'pdf'}
              onChange={(event) =>
                setPreset({
                  layout: event.target.value as AppSettings['exportPreset']['layout'],
                })
              }
              className="h-8 rounded-nb-xs border border-[var(--nb-control-border)] bg-[var(--nb-control-surface)] px-2 disabled:opacity-50"
            >
              <option value="combined">{t('export.combined')}</option>
              <option value="separate">{t('export.separate')}</option>
            </select>
          </label>
          <label className="flex items-center justify-between gap-4 text-[13px]">
            {t('export.includeToc')}
            <input
              type="checkbox"
              checked={preset.includeToc}
              onChange={(event) => setPreset({ includeToc: event.target.checked })}
              className="accent-[var(--nb-accent)]"
            />
          </label>
          <p className="text-[12px] text-nb-text-3">
            {t('export.noteCount', { count: ids.length })}
          </p>
          {message && <p className="text-[12px] text-nb-text-2">{message}</p>}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <GlassButton size="sm" onClick={() => setOpen(false)}>
            {t('common.cancel')}
          </GlassButton>
          <GlassButton size="sm" variant="accent" disabled={!ids.length || working} onClick={() => void run()}>
            {working ? t('export.exporting') : t('export.action')}
          </GlassButton>
        </div>
      </div>
    </ModalOverlay>
  );
}
