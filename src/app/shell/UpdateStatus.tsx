/**
 * A new release, in the status bar beside the version number.
 *
 * Not a dialog and not a banner: a background check that finds a release puts
 * one small accent item here and nothing else, so a student mid-lecture is
 * never interrupted. Clicking it opens a glass popover with the notes and the
 * one action that applies — install, then restart. The download runs while
 * they keep typing; the restart is theirs to choose, and saves the open note
 * first. The popover also opens on its own when the menu command finds a
 * release, since then the student asked.
 */
import { ArrowDownToLine, CircleAlert, Loader2, RotateCw, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { GlassButton, GlassIconButton } from '@/components/glass';
import { useUiStore } from '@/lib/state/uiStore';
import { updateOffered, useUpdaterStore } from '@/lib/state/updaterStore';
import { cn } from '@/lib/utils/cn';

export function UpdateStatus() {
  const { t } = useTranslation();
  const state = useUpdaterStore();
  const { phase, version, notes, downloaded, total, error, popoverOpen } = state;
  const root = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!popoverOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) {
        useUpdaterStore.getState().setPopoverOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') useUpdaterStore.getState().setPopoverOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [popoverOpen]);

  if (!updateOffered(state) || !version) return null;

  const percent = total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : null;
  const label =
    phase === 'downloading'
      ? percent === null
        ? t('updates.statusDownloadingPlain')
        : t('updates.statusDownloading', { percent })
      : phase === 'ready'
        ? t('updates.statusReady')
        : phase === 'error'
          ? t('updates.statusFailed')
          : t('updates.statusAvailable', { version });
  const Icon =
    phase === 'downloading'
      ? Loader2
      : phase === 'ready'
        ? RotateCw
        : phase === 'error'
          ? CircleAlert
          : ArrowDownToLine;

  async function restart(): Promise<void> {
    const refused = await useUpdaterStore.getState().restart();
    if (refused) useUiStore.getState().showStatusNotice(t(`updates.refused.${refused}`));
  }

  return (
    <span ref={root} className="relative flex shrink-0">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={popoverOpen}
        onClick={() => state.setPopoverOpen(!popoverOpen)}
        className={cn(
          'flex items-center gap-1.5 tabular-nums hover:underline',
          phase === 'error' ? 'text-[var(--nb-danger)]' : 'text-[var(--nb-accent)]',
        )}
      >
        <Icon
          size={11}
          className={cn(
            'shrink-0',
            phase === 'downloading' && 'animate-spin motion-reduce:animate-none',
          )}
          aria-hidden
        />
        {label}
      </button>

      {popoverOpen && (
        <div
          role="dialog"
          aria-labelledby="nb-update-title"
          className={cn(
            'absolute bottom-[calc(100%+8px)] right-[-6px] z-30 flex w-[17.5rem] flex-col',
            'rounded-[12px] border-[0.5px] border-[var(--nb-control-border)]',
            'bg-[var(--nb-menu-surface)] text-[12px] text-nb-text-2 shadow-[var(--nb-shadow-lg)]',
          )}
        >
          <header className="flex items-center justify-between gap-2 py-2 pl-3 pr-1.5">
            <span id="nb-update-title" className="font-semibold text-nb-text">
              {t('updates.title', { version })}
            </span>
            <GlassIconButton
              label={t('updates.close')}
              onClick={() => state.setPopoverOpen(false)}
            >
              <X size={11} />
            </GlassIconButton>
          </header>

          <p className="px-3 leading-snug">
            {phase === 'downloading'
              ? t('updates.downloading')
              : phase === 'ready'
                ? t('updates.ready')
                : phase === 'error' && error
                  ? t(`updates.error.${error}`)
                  : t('updates.available', { current: __APP_VERSION__ })}
          </p>

          {phase === 'downloading' && (
            <span className="mx-3 mt-2 h-1 overflow-hidden rounded-full bg-[var(--nb-active)]">
              <span
                className="block h-full rounded-full bg-[var(--nb-accent)] transition-[width]"
                style={{ width: `${percent ?? 8}%` }}
              />
            </span>
          )}

          {notes && phase !== 'ready' && (
            <div className="mx-3 mt-2.5">
              <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-nb-text-3">
                {t('updates.notes')}
              </p>
              <p className="max-h-32 overflow-y-auto whitespace-pre-wrap rounded-nb-xs bg-[var(--nb-inset-surface)] px-2 py-1.5 text-[11.5px] leading-snug">
                {notes}
              </p>
            </div>
          )}

          <footer className="flex flex-col gap-1.5 p-3">
            {(phase === 'available' || phase === 'error') && (
              <GlassButton
                size="sm"
                variant="accent"
                className="w-full justify-center"
                onClick={() => void state.install()}
              >
                {phase === 'error' ? t('updates.retry') : t('updates.install')}
              </GlassButton>
            )}
            {phase === 'ready' && (
              <GlassButton
                size="sm"
                variant="accent"
                className="w-full justify-center"
                onClick={() => void restart()}
              >
                {t('updates.restart')}
              </GlassButton>
            )}
            {phase !== 'downloading' && (
              <div className="flex justify-between gap-2">
                <GlassButton size="sm" variant="ghost" onClick={() => state.later()}>
                  {t('updates.later')}
                </GlassButton>
                {phase !== 'ready' && (
                  <GlassButton size="sm" variant="ghost" onClick={() => void state.skip()}>
                    {t('updates.skip')}
                  </GlassButton>
                )}
              </div>
            )}
          </footer>
        </div>
      )}
    </span>
  );
}
