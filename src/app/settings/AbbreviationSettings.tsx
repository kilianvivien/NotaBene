/**
 * Typing shortcuts.
 *
 * Edits are held locally and written to settings on blur. A half-typed row is
 * not a shortcut — persisting on every keystroke would save `t` → `` and expand
 * it in the note behind the modal while the user is still typing the pair.
 */
import { useState } from 'react';
import { ArrowRight, Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { FieldNote, GlassButton } from '@/components/glass';
import type { Abbreviation } from '@/lib/adapters';
import {
  MAX_EXPANSION_LENGTH,
  MAX_TRIGGER_LENGTH,
  createAbbreviation,
  normalizeAbbreviations,
} from '@/lib/notes/abbreviations';
import { useSettingsStore } from '@/lib/state/settingsStore';
import { cn } from '@/lib/utils/cn';

const INPUT_CLASS =
  'h-7 w-full min-w-0 rounded-nb-xs border border-[var(--nb-control-border)] bg-[var(--nb-control-surface)] px-2 text-[12px] text-nb-text focus:outline-none focus:ring-2 focus:ring-[var(--nb-accent-ring)]';

export function AbbreviationSettings() {
  const { t } = useTranslation();
  const update = useSettingsStore((state) => state.update);
  const [rows, setRows] = useState<Abbreviation[]>(
    () => useSettingsStore.getState().settings.abbreviations,
  );

  function save(next: Abbreviation[]): void {
    setRows(next);
    void update({ abbreviations: normalizeAbbreviations(next) });
  }

  function edit(id: string, patch: Partial<Abbreviation>): void {
    setRows((current) =>
      current.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    );
  }

  /** Which rows will never fire, so the pane can say so instead of leaving the
   * user to wonder why their third `def` does nothing. */
  const duplicates = new Set<string>();
  const seen = new Set<string>();
  for (const row of rows) {
    const key = row.trigger.trim().toLowerCase();
    if (!key) continue;
    if (seen.has(key)) duplicates.add(row.id);
    seen.add(key);
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-[15px] font-semibold">{t('abbreviations.title')}</h2>
        <p className="mt-1 text-[12px] leading-snug text-nb-text-3">
          {t('abbreviations.description')}
        </p>
      </div>

      <div className="overflow-hidden rounded-nb-sm border border-[var(--nb-divider)]">
        {rows.length === 0 ? (
          <p className="p-3 text-[12px] text-nb-text-3">{t('abbreviations.empty')}</p>
        ) : (
          <>
            <div className="grid grid-cols-[minmax(0,1fr)_16px_minmax(0,1.6fr)_28px] items-center gap-2 border-b border-[var(--nb-divider)] bg-[var(--nb-inset-surface)] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-nb-text-3">
              <span>{t('abbreviations.trigger')}</span>
              <span aria-hidden />
              <span>{t('abbreviations.expansion')}</span>
              <span aria-hidden />
            </div>
            <ul className="divide-y divide-[var(--nb-divider)]">
              {rows.map((row) => (
                <li key={row.id} className="px-3 py-2">
                  <div className="grid grid-cols-[minmax(0,1fr)_16px_minmax(0,1.6fr)_28px] items-center gap-2">
                    <input
                      value={row.trigger}
                      maxLength={MAX_TRIGGER_LENGTH}
                      spellCheck={false}
                      autoComplete="off"
                      aria-label={t('abbreviations.trigger')}
                      placeholder={t('abbreviations.triggerPlaceholder')}
                      className={cn(INPUT_CLASS, 'font-mono')}
                      onChange={(event) => edit(row.id, { trigger: event.target.value })}
                      onBlur={() => save(rows)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') event.currentTarget.blur();
                      }}
                    />
                    <ArrowRight size={13} className="text-nb-text-3" aria-hidden />
                    <input
                      value={row.expansion}
                      maxLength={MAX_EXPANSION_LENGTH}
                      aria-label={t('abbreviations.expansion')}
                      placeholder={t('abbreviations.expansionPlaceholder')}
                      className={INPUT_CLASS}
                      onChange={(event) =>
                        edit(row.id, { expansion: event.target.value })
                      }
                      onBlur={() => save(rows)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') event.currentTarget.blur();
                      }}
                    />
                    <button
                      type="button"
                      aria-label={t('abbreviations.remove')}
                      title={t('abbreviations.remove')}
                      onClick={() => save(rows.filter((entry) => entry.id !== row.id))}
                      className="flex size-7 items-center justify-center rounded-nb-xs text-nb-text-3 hover:bg-[var(--nb-hover)] hover:text-[var(--nb-danger)]"
                    >
                      <Trash2 size={13} aria-hidden />
                    </button>
                  </div>
                  {duplicates.has(row.id) && (
                    <p className="mt-1 text-[11px] text-[var(--nb-danger)]">
                      {t('abbreviations.duplicate')}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <div>
        <GlassButton size="sm" onClick={() => setRows([...rows, createAbbreviation()])}>
          <Plus size={12} aria-hidden />
          {t('abbreviations.add')}
        </GlassButton>
        <FieldNote>{t('abbreviations.hint')}</FieldNote>
      </div>
    </div>
  );
}
