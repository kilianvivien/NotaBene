import { History, Tag } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GlassSegmentedControl } from '@/components/glass';
import { AttachmentPanel } from '@/editor/attachments/AttachmentPanel';
import { library } from '@/lib/adapters';
import { docStats } from '@/lib/notes/docText';
import { useEditorStore } from '@/lib/state/editorStore';
import { useLibraryStore } from '@/lib/state/libraryStore';
import { useUiStore } from '@/lib/state/uiStore';

export function Inspector() {
  const { t, i18n } = useTranslation();
  const note = useEditorStore((state) => state.note);
  const tags = useLibraryStore((state) => state.tags);
  const tab = useUiStore((state) => state.inspectorTab);
  const setTab = useUiStore((state) => state.setInspectorTab);
  const [versionCount, setVersionCount] = useState(0);
  const noteId = note?.id;

  useEffect(() => {
    if (!noteId) {
      setVersionCount(0);
      return;
    }
    let active = true;
    void library.listSnapshots(noteId).then((snapshots) => {
      if (active) setVersionCount(snapshots.length);
    });
    return () => {
      active = false;
    };
  }, [noteId]);

  const selectedTags = note
    ? tags.filter((candidate) => note.tagIds.includes(candidate.id))
    : [];
  const visibleTab = tab === 'attachments' ? 'attachments' : 'info';

  return (
    <aside
      aria-label={t('inspector.details')}
      className="flex h-full w-full flex-col gap-4 overflow-y-auto border-l border-[var(--nb-divider)] bg-[var(--nb-sidebar-surface)] p-3"
    >
      <GlassSegmentedControl<'info' | 'attachments'>
        label={t('inspector.details')}
        value={visibleTab}
        onChange={setTab}
        options={[
          { value: 'info', label: t('inspector.details') },
          { value: 'attachments', label: t('inspector.attachments') },
        ]}
        className="nb-inspector-tabs w-full"
      />

      {!note ? (
        <p className="text-[12px] text-nb-text-3">{t('editor.noSelection')}</p>
      ) : visibleTab === 'attachments' ? (
        <AttachmentPanel noteId={note.id} />
      ) : (
        <div className="nb-details-panel">
          <dl>
            <div>
              <dt>{t('inspector.created')}</dt>
              <dd>{new Date(note.createdAt).toLocaleString(i18n.language)}</dd>
            </div>
            <div>
              <dt>{t('inspector.modified')}</dt>
              <dd>{new Date(note.updatedAt).toLocaleString(i18n.language)}</dd>
            </div>
            <div>
              <dt>{t('inspector.wordCount')}</dt>
              <dd>{docStats(note.doc).words}</dd>
            </div>
          </dl>

          <section>
            <h3>
              <Tag size={13} />
              {t('inspector.tags')}
            </h3>
            {selectedTags.length ? (
              <div className="nb-tag-list">
                {selectedTags.map((selected) => (
                  <span key={selected.id}>
                    {selected.namespace ? `${selected.namespace}:` : ''}
                    {selected.name}
                  </span>
                ))}
              </div>
            ) : (
              <p>{t('inspector.noTags')}</p>
            )}
          </section>

          <section>
            <h3>
              <History size={13} />
              {t('inspector.versions')}
            </h3>
            <p>{t('inspector.versionCount', { count: versionCount })}</p>
          </section>
        </div>
      )}
    </aside>
  );
}
