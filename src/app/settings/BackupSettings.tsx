/**
 * Backups.
 *
 * The pane exists to answer one question the old version could not: *are my
 * backups actually happening?* A schedule dropdown and a "last backup" date
 * look identical whether the last four runs succeeded or failed silently, so
 * the health card at the top reports outcomes — including the failures — and
 * the list at the bottom shows the archives that really exist.
 */
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Check, FolderOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  FieldNote,
  FieldRow,
  FieldSection,
  GlassButton,
  GlassSelect,
} from '@/components/glass';
import { dialog, library, storage, type BackupFile } from '@/lib/adapters';
import type { ParsedBackup } from '@/lib/backup';
import {
  nextScheduledBackupAt,
  pickAndWriteBackupCommand,
  pickBackupCommand,
  readBackupCommand,
  restoreBackupCommand,
} from '@/lib/commands';
import { useSettingsStore } from '@/lib/state/settingsStore';
import { formatBytes } from '@/lib/utils/formatBytes';

export function BackupSettings() {
  const { t, i18n } = useTranslation();
  const settings = useSettingsStore((state) => state.settings);
  const update = useSettingsStore((state) => state.update);
  const [backup, setBackup] = useState<ParsedBackup | null>(null);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [conflicts, setConflicts] = useState(0);
  const [archives, setArchives] = useState<BackupFile[]>([]);

  const when = (value: string) => new Date(value).toLocaleString(i18n.language);

  const refreshArchives = useCallback(async () => {
    try {
      setArchives(await storage.listBackups(settings.backupFolder ?? undefined));
    } catch {
      // A folder that has gone away is not an error worth a banner; the empty
      // list already says there is nothing there.
      setArchives([]);
    }
  }, [settings.backupFolder]);

  useEffect(() => {
    void refreshArchives();
  }, [refreshArchives]);

  async function chooseFolder() {
    const folder = await dialog.openFolder();
    if (folder) await update({ backupFolder: folder });
  }

  async function createBackup() {
    setWorking(true);
    const result = await pickAndWriteBackupCommand();
    setWorking(false);
    if (result.ok) {
      setError('');
      setMessage(
        result.value.missingAssets.length > 0
          ? t('backups.createdWithMissing', { count: result.value.missingAssets.length })
          : t('backups.created'),
      );
      await refreshArchives();
    } else if (result.code !== 'not_supported') {
      setMessage('');
      setError(result.message);
    }
  }

  async function preview(loaded: ParsedBackup) {
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
        ...loaded.library.courses,
        ...loaded.library.notes,
        ...loaded.library.tags,
        ...loaded.library.savedSearches,
        ...loaded.library.templates,
      ].filter((entry) => currentIds.has(entry.id)).length,
    );
    setBackup(loaded);
    setMessage('');
    setError('');
  }

  async function selectRestore(path?: string) {
    setWorking(true);
    const result = path ? await readBackupCommand(path) : await pickBackupCommand();
    setWorking(false);
    if (result.ok) await preview(result.value);
    else if (result.code !== 'not_supported') setError(result.message);
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
      setError('');
      setMessage(
        result.value.safetyPath
          ? t('backups.restoredWithSafety', { path: result.value.safetyPath })
          : t('backups.restored'),
      );
      await refreshArchives();
    } else {
      setError(result.message);
    }
  }

  const managed = settings.backupFolder === null;
  const due = nextScheduledBackupAt(settings);

  return (
    <div className="space-y-5">
      <BackupHealth />

      <FieldSection title={t('backups.scheduleSection')}>
        <FieldRow label={t('backups.schedule')} hint={t('backups.scheduleHint')}>
          <GlassSelect
            label={t('backups.schedule')}
            value={settings.backupSchedule}
            onChange={(event) =>
              void update({
                backupSchedule: event.target.value as typeof settings.backupSchedule,
              })
            }
          >
            <option value="off">{t('backups.off')}</option>
            <option value="daily">{t('backups.daily')}</option>
            <option value="weekly">{t('backups.weekly')}</option>
          </GlassSelect>
        </FieldRow>
        <FieldRow
          label={t('backups.folder')}
          hint={managed ? t('backups.managedFolder') : settings.backupFolder!}
          align="end"
        >
          <div className="flex items-center gap-2">
            {!managed && (
              <GlassButton size="sm" onClick={() => void update({ backupFolder: null })}>
                {t('backups.useManaged')}
              </GlassButton>
            )}
            <GlassButton size="sm" onClick={() => void chooseFolder()}>
              {t('backups.chooseFolder')}
            </GlassButton>
          </div>
        </FieldRow>
        {settings.backupSchedule !== 'off' && due && (
          <FieldNote>
            {t('backups.nextRun', {
              date: due.getTime() <= Date.now() ? t('backups.dueNow') : when(due.toISOString()),
            })}
          </FieldNote>
        )}
      </FieldSection>

      <FieldSection title={t('backups.retentionSection')}>
        <FieldRow label={t('backups.keep')} hint={t('backups.keepHint')} align="end">
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              max={365}
              aria-label={t('backups.keep')}
              value={settings.backupsToKeep}
              onChange={(event) =>
                void update({ backupsToKeep: Math.max(1, Number(event.target.value)) })
              }
              className="h-8 w-20 rounded-nb-xs border border-[var(--nb-control-border)] bg-[var(--nb-control-surface)] px-2 text-[12px]"
            />
            <span className="text-[12px] text-nb-text-3">{t('backups.archives')}</span>
          </div>
        </FieldRow>
        <FieldRow label={t('backups.versions')}>
          <GlassSelect
            label={t('backups.versions')}
            value={settings.snapshotRetention}
            onChange={(event) =>
              void update({
                snapshotRetention: event.target
                  .value as typeof settings.snapshotRetention,
              })
            }
          >
            <option value="standard">{t('backups.retentionStandard')}</option>
            <option value="extended">{t('backups.retentionExtended')}</option>
            <option value="forever">{t('backups.retentionForever')}</option>
          </GlassSelect>
        </FieldRow>
        <FieldRow label={t('backups.trashRetention')} align="end">
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              max={3650}
              aria-label={t('backups.trashRetention')}
              value={settings.trashRetentionDays}
              onChange={(event) =>
                void update({ trashRetentionDays: Number(event.target.value) })
              }
              className="h-8 w-20 rounded-nb-xs border border-[var(--nb-control-border)] bg-[var(--nb-control-surface)] px-2 text-[12px]"
            />
            <span className="text-[12px] text-nb-text-3">{t('backups.days')}</span>
          </div>
        </FieldRow>
      </FieldSection>

      <div className="flex flex-wrap gap-2 border-t border-[var(--nb-divider)] pt-4">
        <GlassButton
          size="sm"
          variant="accent"
          disabled={working}
          onClick={() => void createBackup()}
        >
          {t('backups.backupNow')}
        </GlassButton>
        <GlassButton size="sm" disabled={working} onClick={() => void selectRestore()}>
          {t('backups.restore')}
        </GlassButton>
      </div>
      {message && <p className="text-[12px] text-nb-text-2">{message}</p>}
      {error && <FieldNote tone="danger">{error}</FieldNote>}

      {backup && (
        <section className="rounded-nb-sm border border-[var(--nb-divider)] p-3">
          <h3 className="text-[13px] font-semibold">{t('backups.restoreTitle')}</h3>
          <p className="mt-1 text-[12px] text-nb-text-3">
            {t('backups.preview', {
              notes: backup.manifest.counts.notes,
              courses: backup.manifest.counts.courses,
              assets: backup.manifest.counts.assets,
              date: when(backup.manifest.createdAt),
            })}
          </p>
          <p className="mt-1 text-[12px] text-nb-text-3">
            {t('backups.conflicts', { count: conflicts })}
          </p>
          {backup.manifest.missingAssets.length > 0 && (
            <FieldNote tone="danger">
              {t('backups.missingAssets', {
                count: backup.manifest.missingAssets.length,
              })}
            </FieldNote>
          )}
          <FieldNote>{t('backups.safetyPromise')}</FieldNote>
          <div className="mt-3 flex gap-2">
            <GlassButton size="sm" disabled={working} onClick={() => void restore('merge')}>
              {t('backups.merge')}
            </GlassButton>
            <GlassButton
              size="sm"
              variant="danger"
              disabled={working}
              onClick={() => void restore('replace')}
            >
              {t('backups.replace')}
            </GlassButton>
            <GlassButton size="sm" onClick={() => setBackup(null)}>
              {t('common.cancel')}
            </GlassButton>
          </div>
        </section>
      )}

      <FieldSection
        title={t('backups.archivesSection')}
        description={
          managed ? t('backups.archivesManagedHint') : t('backups.archivesChosenHint')
        }
      >
        {archives.length === 0 ? (
          <FieldNote>{t('backups.noArchives')}</FieldNote>
        ) : (
          <ul className="mt-1 flex flex-col gap-px">
            {archives.map((file) => (
              <li
                key={file.path}
                className="flex items-center gap-3 rounded-nb-xs px-2 py-1.5 hover:bg-[var(--nb-hover)]"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12px]">
                    {file.safety ? t('backups.safetyCopy') : when(file.modifiedAt)}
                  </p>
                  <p className="truncate text-[11px] text-nb-text-3">
                    {file.safety ? when(file.modifiedAt) : file.name}
                  </p>
                </div>
                <span className="shrink-0 text-[11px] tabular-nums text-nb-text-3">
                  {formatBytes(file.bytes, settings.locale)}
                </span>
                <GlassButton
                  size="sm"
                  variant="ghost"
                  disabled={working}
                  onClick={() => void selectRestore(file.path)}
                >
                  {t('backups.restore')}
                </GlassButton>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-2">
          <GlassButton
            size="sm"
            onClick={() =>
              void storage
                .backupsDir()
                .then((folder) => storage.reveal(settings.backupFolder ?? folder))
                .catch(() => {})
            }
          >
            <FolderOpen size={13} aria-hidden />
            {t('backups.revealFolder')}
          </GlassButton>
        </div>
      </FieldSection>
    </div>
  );
}

/**
 * Outcome, not configuration.
 *
 * `lastBackupAt` alone cannot distinguish "backed up an hour ago" from "backed
 * up an hour ago and has failed every attempt since", which is exactly the
 * state a student needs to be told about.
 */
function BackupHealth() {
  const { t, i18n } = useTranslation();
  const settings = useSettingsStore((state) => state.settings);
  const when = (value: string) => new Date(value).toLocaleString(i18n.language);

  if (settings.lastBackupError) {
    return (
      <div className="flex gap-2.5 rounded-nb-sm border border-[var(--nb-danger)] p-3">
        <AlertTriangle
          size={15}
          className="mt-px shrink-0 text-[var(--nb-danger)]"
          aria-hidden
        />
        <div className="min-w-0">
          <p className="text-[13px] font-medium">
            {settings.lastBackupErrorAt
              ? t('backups.failedAt', { date: when(settings.lastBackupErrorAt) })
              : t('backups.failed')}
          </p>
          <p className="mt-1 break-words text-[12px] leading-snug text-nb-text-2">
            {settings.lastBackupError}
          </p>
          {settings.lastBackupAt && (
            <p className="mt-1.5 text-[11px] text-nb-text-3">
              {t('backups.lastGood', { date: when(settings.lastBackupAt) })}
            </p>
          )}
        </div>
      </div>
    );
  }

  if (!settings.lastBackupAt) {
    return (
      <div className="rounded-nb-sm bg-[var(--nb-inset-surface)] p-3">
        <p className="text-[13px]">{t('backups.neverRun')}</p>
      </div>
    );
  }

  return (
    <div className="flex gap-2.5 rounded-nb-sm bg-[var(--nb-inset-surface)] p-3">
      <Check size={15} className="mt-px shrink-0 text-[var(--nb-success)]" aria-hidden />
      <div className="min-w-0">
        <p className="text-[13px]">
          {t('backups.lastBackup', { date: when(settings.lastBackupAt) })}
        </p>
        {settings.lastBackupPath && (
          <p className="mt-1 break-all font-mono text-[11px] leading-snug text-nb-text-3">
            {settings.lastBackupPath}
          </p>
        )}
      </div>
    </div>
  );
}
