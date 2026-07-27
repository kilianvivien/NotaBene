import { useTranslation } from 'react-i18next';
import { useEditorStore } from '@/lib/state/editorStore';
import { RichTextEditor } from '@/editor/RichTextEditor';

export function EditorPane() {
  const { t } = useTranslation();
  const note = useEditorStore((state) => state.note);
  const setTitle = useEditorStore((state) => state.setTitle);
  const applyDoc = useEditorStore((state) => state.applyDoc);

  if (!note) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-1 text-center">
        <p className="text-[14px] text-nb-text-2">{t('editor.noSelection')}</p>
        <p className="text-[12px] text-nb-text-3">{t('editor.noSelectionHint')}</p>
      </div>
    );
  }

  return (
    <div className="nb-editor-scroll flex flex-1 justify-center overflow-y-auto">
      <div
        className="w-full px-10 pb-28 pt-9"
        style={{ maxWidth: 'calc(var(--nb-editor-measure) + 5rem)' }}
      >
        <input
          value={note.title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder={t('editor.titlePlaceholder')}
          aria-label={t('editor.titlePlaceholder')}
          autoComplete="off"
          className="mb-2 w-full bg-transparent text-[28px] font-semibold tracking-[-0.025em] placeholder:text-nb-text-3 focus:outline-none"
        />
        <RichTextEditor key={note.id} doc={note.doc} onChange={applyDoc} />
      </div>
    </div>
  );
}
