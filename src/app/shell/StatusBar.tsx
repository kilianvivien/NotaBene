import { Bot } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useEditorStore } from '@/lib/state/editorStore';
import { useUiStore } from '@/lib/state/uiStore';
import { docStats } from '@/lib/notes/docText';

/** Save state, note stats, and the agent-activity indicator. The save state is
 * load-bearing UI: it is what replaces a Save button. */
export function StatusBar() {
  const { t } = useTranslation();
  const note = useEditorStore((state) => state.note);
  const saveState = useEditorStore((state) => state.saveState);
  const agentBusy = useUiStore((state) => state.agentBusy);

  const stats = note ? docStats(note.doc) : null;

  return (
    <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-[var(--nb-divider)] bg-[var(--nb-chrome-surface)] px-3 text-[11px] text-nb-text-3">
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

      {agentBusy && (
        <span className="ml-auto flex items-center gap-1.5 text-[var(--nb-accent)]">
          <Bot size={12} />
          {t('mcp.agentWorking')}
        </span>
      )}
    </footer>
  );
}
