import { Bot } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useEditorStore } from '@/lib/state/editorStore';
import { useUiStore } from '@/lib/state/uiStore';
import { docStats } from '@/lib/notes/docText';

/** Save state, note stats, and the agent-activity indicator. The save state is
 * load-bearing UI: it is what replaces a Save button.
 *
 * In concentration mode this bar is off screen until the pointer reaches for
 * it, which is what makes it the right home for the session counters: you can
 * check on a sitting without anything counting at you while you write. */
export function StatusBar() {
  const { t } = useTranslation();
  const note = useEditorStore((state) => state.note);
  const saveState = useEditorStore((state) => state.saveState);
  const agentBusy = useUiStore((state) => state.agentBusy);
  const focusMode = useUiStore((state) => state.focusMode);
  const session = useUiStore((state) => state.focusSession);

  const stats = note ? docStats(note.doc) : null;
  const elapsed = useElapsed(focusMode ? (session?.startedAt ?? null) : null);

  return (
    <footer className="nb-chrome-bottom flex h-6 shrink-0 items-center gap-3 border-t border-[var(--nb-divider)] bg-[var(--nb-chrome-surface)] px-3 text-[11px] text-nb-text-3">
      <span
        aria-live="polite"
        className={saveState === 'error' ? 'text-[var(--nb-danger)]' : undefined}
      >
        {t(`save.${saveState}`)}
      </span>

      {stats && (
        <>
          <span>{t('editor.words', { count: stats.words })}</span>
          <span>{t('editor.characters', { count: stats.characters })}</span>
          <span>{t('editor.readingTime', { count: stats.readingMinutes })}</span>
        </>
      )}

      {focusMode && session && stats && (
        <span className="flex items-center gap-3 font-nb-mono text-[var(--nb-text-2)]">
          <span>
            {t('editor.sessionWords', {
              count: Math.max(0, stats.words - session.startWords),
            })}
          </span>
          <span>{t('editor.sessionTime', { time: elapsed })}</span>
        </span>
      )}

      <span className="ml-auto" aria-hidden />

      {agentBusy && (
        <span className="flex items-center gap-1.5 text-[var(--nb-accent)]">
          <Bot size={12} />
          {t('mcp.agentWorking')}
        </span>
      )}

      <span title={t('app.version', { version: __APP_VERSION__ })}>
        v{__APP_VERSION__}
      </span>
    </footer>
  );
}

/**
 * `mm:ss` since `startedAt`, ticking once a second, or an empty string when
 * there is no sitting. The interval only exists while concentration mode does —
 * a clock running behind a hidden bar for the life of the app is a heartbeat
 * nobody asked for.
 */
function useElapsed(startedAt: number | null): string {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (startedAt === null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);

  if (startedAt === null) return '';
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
