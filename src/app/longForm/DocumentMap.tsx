import { GripVertical, ListTree, Target } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { NoteDoc } from '@/lib/schema';
import {
  documentOutline,
  moveOutlineSection,
  noteWritingTarget,
  setWritingTarget,
} from '@/lib/longForm/outline';
import { editorPrompt } from '@/editor/editorPrompt';
import { cn } from '@/lib/utils/cn';

interface DocumentMapProps {
  doc: NoteDoc;
  editable: boolean;
  onChange(doc: NoteDoc): void;
}

export function DocumentMap({ doc, editable, onChange }: DocumentMapProps) {
  const { t } = useTranslation();
  const outline = useMemo(() => documentOutline(doc), [doc]);
  const [dragged, setDragged] = useState<number | null>(null);
  const baseLevel = Math.min(...outline.map((entry) => entry.level));
  const noteTarget = noteWritingTarget(doc);

  if (!outline.length) return null;

  async function editTarget(sectionIndex: number | null, current: number | null) {
    const value = await editorPrompt({
      title:
        sectionIndex === null
          ? t('longForm.noteTargetPrompt')
          : t('longForm.sectionTargetPrompt'),
      value: current ? String(current) : '',
      placeholder: t('longForm.targetPlaceholder'),
    });
    if (value === null) return;
    const target = value.trim() ? Number(value) : null;
    if (target !== null && (!Number.isInteger(target) || target <= 0)) return;
    onChange(setWritingTarget(doc, target, sectionIndex));
  }

  function navigate(index: number) {
    const ordinal = outline.findIndex((entry) => entry.index === index);
    const heading = document.querySelectorAll<HTMLElement>(
      '.nb-prosemirror h1, .nb-prosemirror h2, .nb-prosemirror h3, .nb-prosemirror h4, .nb-prosemirror h5, .nb-prosemirror h6',
    )[ordinal];
    heading?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    heading?.focus({ preventScroll: true });
  }

  function move(source: number, target: number) {
    const next = moveOutlineSection(doc, source, target);
    if (next !== doc) onChange(next);
  }

  return (
    <aside className="nb-document-map" aria-label={t('longForm.documentMap')}>
      <div className="nb-document-map-title">
        <span className="flex min-w-0 items-center gap-1.5">
          <ListTree size={13} aria-hidden />
          {t('longForm.documentMap')}
        </span>
        {editable && (
          <button
            type="button"
            title={t('longForm.setNoteTarget')}
            aria-label={t('longForm.setNoteTarget')}
            onClick={() => void editTarget(null, noteTarget)}
          >
            <Target size={12} aria-hidden />
          </button>
        )}
      </div>
      {noteTarget && (
        <p className="nb-document-map-note-target">
          {t('longForm.targetWords', { count: noteTarget })}
        </p>
      )}
      <ol>
        {outline.map((entry, position) => {
          const title = entry.title || t('longForm.untitledSection');
          const progress = entry.target
            ? Math.min(100, Math.round((entry.words / entry.target) * 100))
            : null;
          return (
            <li
              key={`${entry.index}-${title}`}
              draggable={editable}
              onDragStart={() => setDragged(entry.index)}
              onDragEnd={() => setDragged(null)}
              onDragOver={(event) => {
                if (editable) event.preventDefault();
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (dragged !== null) move(dragged, entry.index);
                setDragged(null);
              }}
              className={cn(dragged === entry.index && 'is-dragging')}
              style={{ paddingLeft: `${Math.min(3, entry.level - baseLevel) * 12}px` }}
            >
              {editable && (
                <button
                  type="button"
                  className="nb-document-map-grip"
                  title={t('longForm.dragSection')}
                  aria-label={t('longForm.dragSectionNamed', { title })}
                  onKeyDown={(event) => {
                    const other =
                      event.key === 'ArrowUp'
                        ? outline[position - 1]
                        : event.key === 'ArrowDown'
                          ? outline[position + 1]
                          : null;
                    if (!other) return;
                    event.preventDefault();
                    move(entry.index, other.index);
                  }}
                >
                  <GripVertical size={11} aria-hidden />
                </button>
              )}
              <button
                type="button"
                className="nb-document-map-link"
                title={title}
                onClick={() => navigate(entry.index)}
              >
                {title}
              </button>
              {editable && (
                <button
                  type="button"
                  className="nb-document-map-target"
                  title={t('longForm.setSectionTarget')}
                  aria-label={t('longForm.setSectionTargetNamed', { title })}
                  onClick={() => void editTarget(entry.index, entry.target)}
                >
                  {entry.target ? `${entry.words}/${entry.target}` : <Target size={10} />}
                </button>
              )}
              {progress !== null && (
                <span className="nb-document-map-progress" aria-hidden>
                  <span style={{ width: `${progress}%` }} />
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </aside>
  );
}
