import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GlassButton } from '@/components/glass';
import { dialog, library } from '@/lib/adapters';
import type { ParsedBackup } from '@/lib/backup';
import {
  emptyTrashCommand,
  pickAndWriteBackupCommand,
  pickBackupCommand,
  restoreBackupCommand,
} from '@/lib/commands';
import { useSettingsStore } from '@/lib/state/settingsStore';

export function BackupSettings() {
  const { t, i18n } = useTranslation();
  const settings = useSettingsStore((state) => state.settings);
  const update = useSettingsStore((state) => state.update);
  const [backup, setBackup] = useState<ParsedBackup | null>(null);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState('');
  const [conflicts, setConflicts] = useState(0);

  async function chooseFolder() {
    const folder = await dialog.openFolder();
    if (folder) await update({ backupFolder: folder });
  }

  async function createBackup() {
    setWorking(true);
    const result = await pickAndWriteBackupCommand();
    setWorking(false);
    if (result.ok) setMessage(t('backups.created'));
    else if (result.code !== 'not_supported') setMessage(result.message);
  }

  async function selectRestore() {
    setWorking(true);
    const result = await pickBackupCommand();
    setWorking(false);
    if (result.ok) {
      const current = await library.exportLibrary();
      const currentIds = new Set([
        ...current.courses.map((entry) => entry.id),
        ...current.notes.map((entry) => entry.id),
        ...current.tags.map((entry) => entry.id),
        ...current.savedSearches.map((entry) => entry.id),
        ...current.templates.map((entry) => entry.id),
      ]);
      setConflicts(
        [
          ...result.value.library.courses,
          ...result.value.library.notes,
          ...result.value.library.tags,
          ...result.value.library.savedSearches,
          ...result.value.library.templates,
        ].filter((entry) => currentIds.has(entry.id)).length,
      );
      setBackup(result.value);
      setMessage('');
    } else if (result.code !== 'not_supported') {
      setMessage(result.message);
    }
  }

  async function restore(mode: 'replace' | 'merge') {
    if (!backup) return;
    if (
      mode === 'replace' &&
      !(await dialog.confirm(t('backups.replaceConfirm'), {
        title: t('backups.restoreTitle'),
        danger: true,
      }))
    ) {
      return;
    }
    setWorking(true);
    const result = await restoreBackupCommand(backup, mode);
    setWorking(false);
    if (result.ok) {
      setBackup(null);
      setMessage(t('backups.restored'));
    } else {
      setMessage(result.message);
    }
  }

  async function emptyTrash() {
    if (
      !(await dialog.confirm(t('backups.emptyTrashConfirm'), {
        title: t('sidebar.trash'),
        danger: true,
      }))
    ) {
      return;
    }
    const result = await emptyTrashCommand();
    if (result.ok) setMessage(t('backups.trashEmptied', { count: result.value }));
    else setMessage(result.message);
  }

  return (
    <div className="space-y-5">
      <SettingRow label={t('backups.schedule')} hint={t('backups.scheduleHint')}>
        <select
          value={settings.backupSchedule}
          onChange={(event) =>
            void update({
              backupSchedule: event.target.value as typeof settings.backupSchedule,
            })
          }
          className="h-8 rounded-nb-xs border border-[var(--nb-control-border)] bg-[var(--nb-control-surface)] px-2 text-[12px]"
        >
          <option value="off">{t('backups.off')}</option>
          <option value="daily">{t('backups.daily')}</option>
          <option value="weekly">{t('backups.weekly')}</option>
        </select>
      </SettingRow>
      <SettingRow
        label={t('backups.folder')}
        hint={settings.backupFolder ?? t('backups.noFolder')}
      >
        <GlassButton size="sm" onClick={() => void chooseFolder()}>
          {t('backups.chooseFolder')}
        </GlassButton>
      </SettingRow>
      <SettingRow label={t('backups.versions')}>
        <select
          value={settings.snapshotRetention}
          onChange={(event) =>
            void update({
              snapshotRetention: event.target.value as typeof settings.snapshotRetention,
            })
          }
          className="h-8 rounded-nb-xs border border-[var(--nb-control-border)] bg-[var(--nb-control-surface)] px-2 text-[12px]"
        >
          <option value="standard">{t('backups.retentionStandard')}</option>
          <option value="extended">{t('backups.retentionExtended')}</option>
          <option value="forever">{t('backups.retentionForever')}</option>
        </select>
      </SettingRow>
      <SettingRow label={t('backups.trashRetention')}>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={1}
            max={3650}
            value={settings.trashRetentionDays}
            onChange={(event) =>
              void update({ trashRetentionDays: Number(event.target.value) })
            }
            className="h-8 w-20 rounded-nb-xs border border-[var(--nb-control-border)] bg-[var(--nb-control-surface)] px-2 text-[12px]"
          />
          <span className="text-[12px] text-nb-text-3">{t('backups.days')}</span>
        </div>
      </SettingRow>
      <div className="flex flex-wrap gap-2 border-t border-[var(--nb-divider)] pt-4">
        <GlassButton size="sm" variant="accent" disabled={working} onClick={() => void createBackup()}>
          {t('backups.backupNow')}
        </GlassButton>
        <GlassButton size="sm" disabled={working} onClick={() => void selectRestore()}>
          {t('backups.restore')}
        </GlassButton>
        <GlassButton size="sm" disabled={working} onClick={() => void emptyTrash()}>
          {t('backups.emptyTrash')}
        </GlassButton>
      </div>
      {settings.lastBackupAt && (
        <p className="text-[11px] text-nb-text-3">
          {t('backups.lastBackup', {
            date: new Date(settings.lastBackupAt).toLocaleString(i18n.language),
          })}
        </p>
      )}
      {message && <p className="text-[12px] text-nb-text-2">{message}</p>}
      {backup && (
        <section className="rounded-nb-sm border border-[var(--nb-divider)] p-3">
          <h3 className="text-[13px] font-semibold">{t('backups.restoreTitle')}</h3>
          <p className="mt-1 text-[12px] text-nb-text-3">
            {t('backups.preview', {
              notes: backup.manifest.counts.notes,
              courses: backup.manifest.counts.courses,
              assets: backup.manifest.counts.assets,
              date: new Date(backup.manifest.createdAt).toLocaleString(i18n.language),
            })}
          </p>
          <p className="mt-1 text-[12px] text-nb-text-3">
            {t('backups.conflicts', { count: conflicts })}
          </p>
          <div className="mt-3 flex gap-2">
            <GlassButton size="sm" disabled={working} onClick={() => void restore('merge')}>
              {t('backups.merge')}
            </GlassButton>
            <GlassButton size="sm" variant="danger" disabled={working} onClick={() => void restore('replace')}>
              {t('backups.replace')}
            </GlassButton>
            <GlassButton size="sm" onClick={() => setBackup(null)}>
              {t('common.cancel')}
            </GlassButton>
          </div>
        </section>
      )}
    </div>
  );
}

function SettingRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-[13px]">{label}</p>
        {hint && <p className="mt-0.5 max-w-[260px] truncate text-[11px] text-nb-text-3">{hint}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
