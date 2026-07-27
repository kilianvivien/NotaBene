import { useTranslation } from 'react-i18next';
import { useEditorStore } from '@/lib/state/editorStore';
import { flattenDoc } from '@/lib/notes/docText';

/**
 * Phase A editor: a plain textarea over the document's flattened text, enough
 * to prove the open → type → autosave → reopen loop end to end.
 *
 * Phase B replaces the body with the real TipTap editor and its extensions
 * (`src/editor/`). The title field, the save wiring, and the reading measure
 * stay exactly as they are — this pane's contract with `editorStore` does not
 * change.
 */
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
    <div className="flex flex-1 justify-center overflow-y-auto">
      <div
        className="w-full px-10 py-10"
        style={{ maxWidth: 'calc(var(--nb-editor-measure) + 5rem)' }}
      >
        <input
          value={note.title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder={t('editor.titlePlaceholder')}
          aria-label={t('editor.titlePlaceholder')}
          autoComplete="off"
          className="mb-4 w-full bg-transparent text-[26px] font-semibold tracking-tight placeholder:text-nb-text-3 focus:outline-none"
        />

        <textarea
          value={flattenDoc(note.doc)}
          onChange={(event) =>
            applyDoc({
              type: 'doc',
              content: event.target.value
                .split('\n')
                .map((line) =>
                  line
                    ? { type: 'paragraph', content: [{ type: 'text', text: line }] }
                    : { type: 'paragraph' },
                ),
            })
          }
          placeholder={t('editor.bodyPlaceholder')}
          aria-label={t('editor.bodyPlaceholder')}
          className="min-h-[60vh] w-full resize-none bg-transparent placeholder:text-nb-text-3 focus:outline-none"
          style={{
            fontFamily: 'var(--nb-editor-font)',
            fontSize: 'var(--nb-editor-size)',
            lineHeight: 'var(--nb-editor-leading)',
          }}
        />
      </div>
    </div>
  );
}
