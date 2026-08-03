import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  FieldNote,
  FieldRow,
  FieldToggle,
  GlassButton,
  GlassSelect,
} from '@/components/glass';
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
  const [failed, setFailed] = useState(false);

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
    setFailed(false);
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
      setFailed(true);
    }
  }

  // PDF goes through the system print sheet, which has no concept of a file
  // per note. Saying so beats a select that silently ignores what you picked.
  const layoutLocked = preset.format === 'pdf';

  return (
    <Dialog
      open={open}
      onClose={() => setOpen(false)}
      title={t('export.title')}
      size="md"
      footer={
        <>
          <GlassButton size="sm" onClick={() => setOpen(false)}>
            {t('common.cancel')}
          </GlassButton>
          <GlassButton
            size="sm"
            variant="accent"
            disabled={!ids.length || working}
            onClick={() => void run()}
          >
            {working ? t('export.exporting') : t('export.action')}
          </GlassButton>
        </>
      }
    >
      <FieldRow label={t('export.notes')}>
        <GlassSelect
          label={t('export.notes')}
          value={scope}
          onChange={(event) => setScope(event.target.value as typeof scope)}
        >
          <option value="selected">{t('export.selectedNotes')}</option>
          <option value="view">{t('export.currentView')}</option>
        </GlassSelect>
      </FieldRow>

      <FieldRow label={t('export.format')}>
        <GlassSelect
          label={t('export.format')}
          value={preset.format}
          onChange={(event) =>
            setPreset({
              format: event.target.value as AppSettings['exportPreset']['format'],
            })
          }
        >
          <option value="markdown">Markdown</option>
          <option value="html">HTML</option>
          <option value="pdf">PDF</option>
          <option value="docx">DOCX</option>
        </GlassSelect>
      </FieldRow>

      <FieldRow
        label={t('export.layout')}
        hint={layoutLocked ? t('export.layoutPdfHint') : undefined}
      >
        <GlassSelect
          label={t('export.layout')}
          value={layoutLocked ? 'combined' : preset.layout}
          disabled={layoutLocked}
          className="disabled:opacity-50"
          onChange={(event) =>
            setPreset({
              layout: event.target.value as AppSettings['exportPreset']['layout'],
            })
          }
        >
          <option value="combined">{t('export.combined')}</option>
          <option value="separate">{t('export.separate')}</option>
        </GlassSelect>
      </FieldRow>

      <FieldRow label={t('export.includeToc')} align="end">
        <FieldToggle
          label={t('export.includeToc')}
          checked={preset.includeToc}
          onChange={(includeToc) => setPreset({ includeToc })}
        />
      </FieldRow>

      <FieldNote>{t('export.noteCount', { count: ids.length })}</FieldNote>
      {message && <FieldNote tone={failed ? 'danger' : 'muted'}>{message}</FieldNote>}
    </Dialog>
  );
}
