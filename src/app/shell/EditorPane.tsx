import { useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useEditorStore } from '@/lib/state/editorStore';
import { RichTextEditor } from '@/editor/RichTextEditor';
import { useLibraryAccessStore } from '@/lib/state/libraryAccessStore';
import { DocumentMap } from '@/app/longForm/DocumentMap';
import { useUiStore } from '@/lib/state/uiStore';

export function EditorPane() {
  const { t } = useTranslation();
  const note = useEditorStore((state) => state.note);
  const setTitle = useEditorStore((state) => state.setTitle);
  const applyDoc = useEditorStore((state) => state.applyDoc);
  const readOnly = useLibraryAccessStore((state) => state.status?.readOnly === true);
  const documentMapVisible = useUiStore((state) => state.documentMapVisible);
  const titleRef = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const title = titleRef.current;
    if (!title) return;
    title.style.height = 'auto';
    const lineHeight = Number.parseFloat(getComputedStyle(title).lineHeight);
    const maximumHeight = lineHeight * 3;
    title.style.height = `${Math.min(title.scrollHeight, maximumHeight)}px`;
    title.style.overflowY = title.scrollHeight > maximumHeight ? 'auto' : 'hidden';
  }, [note?.title]);

  if (!note) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-1 text-center">
        <p className="text-[14px] text-nb-text-2">{t('editor.noSelection')}</p>
        <p className="text-[12px] text-nb-text-3">{t('editor.noSelectionHint')}</p>
      </div>
    );
  }

  return (
    <div className="nb-editor-scroll flex flex-1 overflow-y-auto">
      <div className="nb-long-form-layout mx-auto flex w-full items-start justify-center">
        {documentMapVisible && (
          <DocumentMap doc={note.doc} editable={!readOnly} onChange={applyDoc} />
        )}
        <div
          className="nb-editor-page min-w-0 flex-1 px-10 pb-28 pt-9"
          style={{ maxWidth: 'calc(var(--nb-editor-measure) + 5rem)' }}
        >
          <textarea
            ref={titleRef}
            rows={1}
            value={note.title}
            readOnly={readOnly}
            onChange={(event) => setTitle(event.target.value.replaceAll(/\r?\n/g, ' '))}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              document.querySelector<HTMLElement>('.nb-prosemirror')?.focus();
            }}
            placeholder={t('editor.titlePlaceholder')}
            aria-label={t('editor.titlePlaceholder')}
            autoComplete="off"
            className="mb-3 block w-full resize-none bg-transparent font-semibold tracking-[-0.03em] placeholder:text-nb-text-3 focus:outline-none"
            style={{
              fontSize: 'var(--nb-editor-title-size)',
              lineHeight: 1.08,
            }}
          />
          <RichTextEditor
            key={note.id}
            doc={note.doc}
            editable={!readOnly}
            onChange={applyDoc}
          />
        </div>
      </div>
    </div>
  );
}
