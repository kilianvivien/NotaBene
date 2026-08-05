/**
 * Data & Storage.
 *
 * The pane that makes "everything stays on your machine" checkable rather than
 * merely stated. It answers three questions and refuses to answer a fourth:
 * where the data is, how much of it there is, and whether the database is
 * sound. It does not offer to change or repair anything — a pane a student
 * opens to reassure themselves should not have a button on it that can make
 * things worse.
 *
 * Backups live one tab over. This is what is on the disk right now; that is
 * what NotaBene does about it.
 */
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Check, FolderOpen, HardDrive, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { FieldNote, FieldSection, GlassButton } from '@/components/glass';
import { storage, type IntegrityReport, type StorageSummary } from '@/lib/adapters';
import { useSettingsStore } from '@/lib/state/settingsStore';
import { formatBytes } from '@/lib/utils/formatBytes';

/**
 * The bar's parts, in order. Opacity rather than distinct hues: four unrelated
 * colours would read as four categories that mean something, and these are one
 * quantity cut four ways.
 */
const SEGMENTS = [
  { key: 'database', opacity: 1 },
  { key: 'attachments', opacity: 0.66 },
  { key: 'backups', opacity: 0.42 },
  { key: 'other', opacity: 0.22 },
] as const;

type SegmentKey = (typeof SEGMENTS)[number]['key'];

function partition(summary: StorageSummary): Record<SegmentKey, number> {
  return {
    // The write-ahead log belongs with the database it is a log of. It is
    // broken out in the interface only when it is large enough to explain a
    // number the user would otherwise find surprising.
    database: summary.databaseBytes + summary.walBytes,
    attachments: summary.assetsBytes,
    backups: summary.backupsBytes,
    other: summary.settingsBytes + summary.otherBytes,
  };
}

export function DataStorageSettings() {
  const { t } = useTranslation();
  const locale = useSettingsStore((state) => state.settings.locale);
  const [summary, setSummary] = useState<StorageSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [report, setReport] = useState<IntegrityReport | null>(null);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setSummary(await storage.summary());
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function check() {
    setChecking(true);
    try {
      setReport(await storage.integrityCheck());
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setChecking(false);
    }
  }

  if (loading && !summary) {
    return (
      <p className="flex items-center gap-2 text-[13px] text-nb-text-3">
        <Loader2 size={14} className="animate-spin" aria-hidden />
        {t('storage.measuring')}
      </p>
    );
  }

  // Null means the platform keeps nothing on disk — the browser build holds the
  // library in memory. A pane full of "0 B" would be a claim about storage; the
  // honest answer is that there is none to describe.
  if (!summary) {
    return <p className="text-[13px] text-nb-text-3">{t('storage.desktopOnly')}</p>;
  }

  const parts = partition(summary);
  const { counts } = summary;

  return (
    <div className="space-y-5">
      {summary.startupProblems.length > 0 && (
        <div className="flex gap-2.5 rounded-nb-sm border border-[var(--nb-danger)] p-3">
          <AlertTriangle
            size={15}
            className="mt-px shrink-0 text-[var(--nb-danger)]"
            aria-hidden
          />
          <div className="min-w-0">
            <p className="text-[13px] font-medium">{t('storage.damagedTitle')}</p>
            <p className="mt-1 text-[12px] leading-snug text-nb-text-2">
              {t('storage.damagedBody')}
            </p>
          </div>
        </div>
      )}

      <FieldSection title={t('storage.locationSection')}>
        <div className="rounded-nb-sm border border-[var(--nb-divider)] bg-[var(--nb-inset-surface)] p-3">
          <div className="flex items-start gap-3">
            <div className="mt-px flex size-8 shrink-0 items-center justify-center rounded-nb-xs bg-[var(--nb-active)]">
              <HardDrive size={15} className="text-nb-text-2" aria-hidden />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] leading-snug">{t('storage.locationBody')}</p>
              <p className="mt-1.5 break-all font-mono text-[11px] leading-snug text-nb-text-3">
                {summary.dataDir}
              </p>
            </div>
            <GlassButton
              size="sm"
              onClick={() => void storage.reveal(summary.dataDir)}
              className="shrink-0"
            >
              <FolderOpen size={13} aria-hidden />
              {t('storage.reveal')}
            </GlassButton>
          </div>
        </div>
      </FieldSection>

      <FieldSection title={t('storage.sizeSection')}>
        <p className="text-[22px] font-semibold tabular-nums tracking-[-0.02em]">
          {formatBytes(summary.totalBytes, locale)}
        </p>
        <div
          className="mt-2.5 flex h-2 gap-px overflow-hidden rounded-full bg-[var(--nb-active)]"
          role="img"
          aria-label={t('storage.breakdownLabel')}
        >
          {SEGMENTS.map(({ key, opacity }) =>
            parts[key] > 0 ? (
              <div
                key={key}
                style={{
                  width: `${(parts[key] / Math.max(summary.totalBytes, 1)) * 100}%`,
                  background: 'var(--nb-accent)',
                  opacity,
                }}
              />
            ) : null,
          )}
        </div>
        <ul className="mt-3 grid grid-cols-2 gap-x-5 gap-y-1.5">
          {SEGMENTS.map(({ key, opacity }) => (
            <li key={key} className="flex items-center gap-2 text-[12px]">
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-full"
                style={{ background: 'var(--nb-accent)', opacity }}
              />
              <span className="min-w-0 flex-1 truncate text-nb-text-2">
                {t(`storage.part_${key}`)}
              </span>
              <span className="shrink-0 tabular-nums text-nb-text-3">
                {formatBytes(parts[key], locale)}
              </span>
            </li>
          ))}
        </ul>
        {summary.walBytes > 0 && (
          <FieldNote>
            {t('storage.walNote', { size: formatBytes(summary.walBytes, locale) })}
          </FieldNote>
        )}
      </FieldSection>

      <FieldSection title={t('storage.contentsSection')}>
        <ul className="grid grid-cols-3 gap-3">
          {(
            [
              ['courses', counts.courses],
              ['notes', counts.notes],
              ['attachments', counts.attachments],
              ['versions', counts.snapshots],
              ['tags', counts.tags],
              ['trashed', counts.trashedNotes],
            ] as const
          ).map(([key, value]) => (
            <li
              key={key}
              className="rounded-nb-sm bg-[var(--nb-inset-surface)] px-3 py-2"
            >
              <p className="text-[17px] font-semibold tabular-nums leading-tight">
                {value.toLocaleString(locale)}
              </p>
              <p className="mt-0.5 text-[11px] text-nb-text-3">
                {t(`storage.count_${key}`)}
              </p>
            </li>
          ))}
        </ul>
      </FieldSection>

      <FieldSection
        title={t('storage.integritySection')}
        description={t('storage.integrityHint')}
      >
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <GlassButton size="sm" disabled={checking} onClick={() => void check()}>
            {checking && <Loader2 size={13} className="animate-spin" aria-hidden />}
            {t('storage.checkNow')}
          </GlassButton>
          {report?.ok && (
            <span className="flex items-center gap-1.5 text-[12px] text-[var(--nb-success)]">
              <Check size={13} aria-hidden />
              {t('storage.integrityOk')}
            </span>
          )}
        </div>
        {report && !report.ok && (
          <ul className="mt-2.5 space-y-1 rounded-nb-sm border border-[var(--nb-danger)] p-2.5">
            {report.problems.map((problem) => (
              <li key={problem} className="font-mono text-[11px] leading-snug break-all">
                {problem}
              </li>
            ))}
          </ul>
        )}
        {error && <FieldNote tone="danger">{error}</FieldNote>}
      </FieldSection>

      <div className="border-t border-[var(--nb-divider)] pt-3">
        <FieldNote>{t('storage.neverStored')}</FieldNote>
      </div>
    </div>
  );
}
