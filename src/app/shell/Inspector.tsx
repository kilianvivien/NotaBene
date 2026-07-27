import { useTranslation } from 'react-i18next';
import { GlassSegmentedControl } from '@/components/glass';
import { useEditorStore } from '@/lib/state/editorStore';
import { useUiStore, type InspectorTab } from '@/lib/state/uiStore';
import { docStats } from '@/lib/notes/docText';

const TABS: InspectorTab[] = ['info', 'tags', 'versions', 'attachments', 'backlinks', 'ai'];

export function Inspector() {
  const { t, i18n } = useTranslation();
  const note = useEditorStore((state) => state.note);
  const tab = useUiStore((state) => state.inspectorTab);
  const setTab = useUiStore((state) => state.setInspectorTab);

  return (
    <aside
      aria-label={t('inspector.info')}
      className="flex w-[280px] shrink-0 flex-col gap-3 overflow-y-auto border-l border-[var(--nb-divider)] p-3"
    >
      <GlassSegmentedControl
        label={t('inspector.info')}
        value={tab}
        onChange={setTab}
        options={TABS.slice(0, 3).map((id) => ({ value: id, label: t(`inspector.${id}`) }))}
        className="w-full"
      />

      {!note ? (
        <p className="text-[12px] text-nb-text-3">{t('editor.noSelection')}</p>
      ) : tab === 'info' ? (
        <dl className="flex flex-col gap-2 text-[12px]">
          <div className="flex justify-between gap-2">
            <dt className="text-nb-text-3">{t('inspector.created')}</dt>
            <dd>{new Date(note.createdAt).toLocaleString(i18n.language)}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-nb-text-3">{t('inspector.modified')}</dt>
            <dd>{new Date(note.updatedAt).toLocaleString(i18n.language)}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-nb-text-3">{t('inspector.wordCount')}</dt>
            <dd>{docStats(note.doc).words}</dd>
          </div>
        </dl>
      ) : (
        // Tags, versions, attachments, backlinks and the AI panel land in
        // phases C, D and E respectively.
        <p className="text-[12px] text-nb-text-3">—</p>
      )}
    </aside>
  );
}
