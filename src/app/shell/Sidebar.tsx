import {
  Archive,
  Files,
  Inbox,
  Pin,
  Plus,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { GlassIconButton } from '@/components/glass';
import { useLibraryStore } from '@/lib/state/libraryStore';
import { useUiStore, type ViewKind } from '@/lib/state/uiStore';
import { createCourseCommand } from '@/lib/commands';
import { cn } from '@/lib/utils/cn';

interface SmartView {
  view: ViewKind;
  icon: LucideIcon;
  labelKey: string;
}

const SMART_VIEWS: SmartView[] = [
  { view: { kind: 'all' }, icon: Files, labelKey: 'sidebar.allNotes' },
  { view: { kind: 'inbox' }, icon: Inbox, labelKey: 'sidebar.inbox' },
  { view: { kind: 'pinned' }, icon: Pin, labelKey: 'sidebar.pinned' },
  { view: { kind: 'archived' }, icon: Archive, labelKey: 'sidebar.archived' },
  { view: { kind: 'trash' }, icon: Trash2, labelKey: 'sidebar.trash' },
];

function sameView(a: ViewKind, b: ViewKind): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'course' && b.kind === 'course') return a.courseId === b.courseId;
  if (a.kind === 'tag' && b.kind === 'tag') return a.tagId === b.tagId;
  return true;
}

export function Sidebar() {
  const { t } = useTranslation();
  const courses = useLibraryStore((state) => state.courses);
  const view = useUiStore((state) => state.view);
  const setView = useUiStore((state) => state.setView);

  return (
    <nav
      aria-label={t('sidebar.courses')}
      className="flex h-full w-full flex-col gap-4 overflow-y-auto border-r border-[var(--nb-divider)] px-2 py-3"
    >
      <ul className="flex flex-col gap-0.5">
        {SMART_VIEWS.map(({ view: target, icon: Icon, labelKey }) => (
          <li key={labelKey}>
            <button
              type="button"
              onClick={() => setView(target)}
              aria-current={sameView(view, target) ? 'page' : undefined}
              className={cn(
                'flex h-7 w-full items-center gap-2 rounded-nb-xs px-2 text-[13px]',
                'transition-colors duration-[var(--nb-t-fast)]',
                sameView(view, target)
                  ? 'bg-[var(--nb-accent-soft)] text-[var(--nb-accent)]'
                  : 'text-nb-text-2 hover:bg-[var(--nb-hover)]',
              )}
            >
              <Icon size={14} />
              {t(labelKey)}
            </button>
          </li>
        ))}
      </ul>

      <section>
        <div className="mb-1 flex items-center justify-between px-2">
          <h2 className="text-[11px] font-semibold uppercase tracking-wide text-nb-text-3">
            {t('sidebar.courses')}
          </h2>
          <GlassIconButton
            label={t('sidebar.newCourse')}
            className="size-6"
            onClick={() => void createCourseCommand({ name: t('sidebar.newCourse') })}
          >
            <Plus size={13} />
          </GlassIconButton>
        </div>

        {courses.length === 0 ? (
          <p className="px-2 text-[12px] text-nb-text-3">{t('sidebar.noCourses')}</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {courses.map((course) => {
              const target: ViewKind = { kind: 'course', courseId: course.id };
              return (
                <li key={course.id}>
                  <button
                    type="button"
                    onClick={() => setView(target)}
                    aria-current={sameView(view, target) ? 'page' : undefined}
                    className={cn(
                      'flex h-7 w-full items-center gap-2 rounded-nb-xs px-2 text-[13px]',
                      'transition-colors duration-[var(--nb-t-fast)]',
                      sameView(view, target)
                        ? 'bg-[var(--nb-accent-soft)] text-[var(--nb-accent)]'
                        : 'text-nb-text-2 hover:bg-[var(--nb-hover)]',
                    )}
                  >
                    <span aria-hidden>{course.icon}</span>
                    <span className="truncate">{course.name}</span>
                    <span
                      aria-hidden
                      className="ml-auto size-2 shrink-0 rounded-full"
                      style={{ background: course.color }}
                    />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </nav>
  );
}
