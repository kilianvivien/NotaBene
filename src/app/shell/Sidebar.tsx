import { useState } from 'react';
import {
  Archive,
  ChevronDown,
  ChevronRight,
  Files,
  FileStack,
  GripVertical,
  Inbox,
  Pin,
  Plus,
  Search,
  Settings2,
  Tags,
  Trash2,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { GlassIconButton } from '@/components/glass';
import {
  createNoteFromTemplateCommand,
  createSectionCommand,
  deleteSavedSearchCommand,
  deleteSectionCommand,
  deleteTemplateCommand,
  reorderCoursesCommand,
  reorderSectionsCommand,
  saveNoteAsTemplateCommand,
  trashNoteCommand,
  updateSectionCommand,
} from '@/lib/commands';
import type { Course, SavedSearch, Section } from '@/lib/schema';
import { useEditorStore } from '@/lib/state/editorStore';
import { useLibraryStore } from '@/lib/state/libraryStore';
import { useUiStore, type ViewKind } from '@/lib/state/uiStore';
import { cn } from '@/lib/utils/cn';
import {
  CourseDialog,
  NameDialog,
  SavedSearchDialog,
  TagManagerDialog,
} from '@/app/organization/OrganizationModals';

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
  if (a.kind === 'course' && b.kind === 'course') {
    return a.courseId === b.courseId && a.sectionId === b.sectionId;
  }
  if (a.kind === 'tag' && b.kind === 'tag') return a.tagId === b.tagId;
  if (a.kind === 'savedSearch' && b.kind === 'savedSearch') {
    return a.savedSearchId === b.savedSearchId;
  }
  return true;
}

const rowClass =
  'group flex h-7 w-full items-center gap-2 rounded-nb-xs px-2 text-[13px] transition-colors duration-[var(--nb-t-fast)]';

export function Sidebar() {
  const { t } = useTranslation();
  const courses = useLibraryStore((state) => state.courses);
  const sections = useLibraryStore((state) => state.sections);
  const tags = useLibraryStore((state) => state.tags);
  const savedSearches = useLibraryStore((state) => state.savedSearches);
  const templates = useLibraryStore((state) => state.templates);
  const refreshSections = useLibraryStore((state) => state.refreshSections);
  const view = useUiStore((state) => state.view);
  const setView = useUiStore((state) => state.setView);
  const selectNote = useUiStore((state) => state.selectNote);
  const note = useEditorStore((state) => state.note);
  const openNote = useEditorStore((state) => state.openNote);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [courseDialog, setCourseDialog] = useState<Course | null | 'new'>(null);
  const [tagManagerOpen, setTagManagerOpen] = useState(false);
  const [templateNameOpen, setTemplateNameOpen] = useState(false);
  const [sectionCourseId, setSectionCourseId] = useState<string | null>(null);
  const [draggedCourseId, setDraggedCourseId] = useState<string | null>(null);
  const [draggedSectionId, setDraggedSectionId] = useState<string | null>(null);
  const [editingSearch, setEditingSearch] = useState<SavedSearch | null>(null);
  const [editingSection, setEditingSection] = useState<Section | null>(null);
  const [trashDropActive, setTrashDropActive] = useState(false);

  async function toggleCourse(courseId: string) {
    const next = new Set(expanded);
    if (next.has(courseId)) next.delete(courseId);
    else {
      next.add(courseId);
      await refreshSections(courseId);
    }
    setExpanded(next);
  }

  async function openTemplate(templateId: string) {
    const template = templates.find((candidate) => candidate.id === templateId);
    if (!template) return;
    const result = await createNoteFromTemplateCommand(template);
    if (!result.ok) return;
    selectNote(result.value.id);
    await openNote(result.value.id);
  }

  return (
    <>
      <nav
        aria-label={t('sidebar.courses')}
        className="flex h-full w-full flex-col gap-4 overflow-y-auto border-r border-[var(--nb-divider)] bg-[var(--nb-sidebar-surface)] px-2 py-3"
      >
        <ul className="flex flex-col gap-0.5">
          {SMART_VIEWS.map(({ view: target, icon: Icon, labelKey }) => (
            <li key={labelKey}>
              <button
                type="button"
                onClick={() => setView(target)}
                onDragEnter={() => {
                  if (target.kind === 'trash') setTrashDropActive(true);
                }}
                onDragLeave={() => {
                  if (target.kind === 'trash') setTrashDropActive(false);
                }}
                onDragOver={(event) => {
                  if (target.kind !== 'trash') return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'move';
                }}
                onDrop={(event) => {
                  if (target.kind !== 'trash') return;
                  event.preventDefault();
                  setTrashDropActive(false);
                  const noteId =
                    event.dataTransfer.getData('application/x-notabene-note-id') ||
                    event.dataTransfer.getData('text/plain');
                  if (noteId) void trashNoteCommand(noteId);
                }}
                aria-current={sameView(view, target) ? 'page' : undefined}
                className={cn(
                  rowClass,
                  target.kind === 'trash' && trashDropActive
                    ? 'bg-[var(--nb-active)] text-[var(--nb-danger)] ring-1 ring-[var(--nb-danger)]'
                    : sameView(view, target)
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

        <SidebarSection
          title={t('sidebar.courses')}
          action={
            <GlassIconButton
              label={t('sidebar.newCourse')}
              className="size-6"
              onClick={() => setCourseDialog('new')}
            >
              <Plus size={13} />
            </GlassIconButton>
          }
        >
          {courses.length === 0 ? (
            <p className="px-2 text-[12px] text-nb-text-3">{t('sidebar.noCourses')}</p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {courses.map((course) => {
                const courseView: ViewKind = { kind: 'course', courseId: course.id };
                const open = expanded.has(course.id);
                return (
                  <li
                    key={course.id}
                    draggable
                    onDragStart={() => setDraggedCourseId(course.id)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={() => {
                      if (!draggedCourseId || draggedCourseId === course.id) return;
                      const ids = courses.map((candidate) => candidate.id);
                      const from = ids.indexOf(draggedCourseId);
                      const to = ids.indexOf(course.id);
                      ids.splice(to, 0, ids.splice(from, 1)[0]!);
                      void reorderCoursesCommand(ids);
                      setDraggedCourseId(null);
                    }}
                  >
                    <div className="flex items-center">
                      <button
                        type="button"
                        className="grid size-6 shrink-0 place-items-center text-nb-text-3"
                        aria-label={
                          open ? t('organization.collapse') : t('organization.expand')
                        }
                        onClick={() => void toggleCourse(course.id)}
                      >
                        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                      </button>
                      <button
                        type="button"
                        onClick={() => setView(courseView)}
                        onDoubleClick={() => setCourseDialog(course)}
                        aria-current={sameView(view, courseView) ? 'page' : undefined}
                        className={cn(
                          rowClass,
                          'min-w-0 flex-1 pl-1',
                          sameView(view, courseView)
                            ? 'bg-[var(--nb-accent-soft)] text-[var(--nb-accent)]'
                            : 'text-nb-text-2 hover:bg-[var(--nb-hover)]',
                        )}
                      >
                        <GripVertical
                          size={11}
                          className="opacity-0 group-hover:opacity-50"
                        />
                        <span aria-hidden>{course.icon}</span>
                        <span className="truncate">{course.name}</span>
                        <span
                          aria-hidden
                          className="ml-auto size-2 shrink-0 rounded-full"
                          style={{ background: course.color }}
                        />
                      </button>
                    </div>
                    {open && (
                      <ul className="ml-6 border-l border-[var(--nb-divider)] pl-1">
                        {(sections[course.id] ?? []).map((section) => {
                          const target: ViewKind = {
                            kind: 'course',
                            courseId: course.id,
                            sectionId: section.id,
                          };
                          return (
                            <li
                              key={section.id}
                              draggable
                              onDragStart={() => setDraggedSectionId(section.id)}
                              onDragOver={(event) => event.preventDefault()}
                              onDrop={() => {
                                if (!draggedSectionId || draggedSectionId === section.id)
                                  return;
                                const siblings = sections[course.id] ?? [];
                                const ids = siblings.map((candidate) => candidate.id);
                                const from = ids.indexOf(draggedSectionId);
                                const to = ids.indexOf(section.id);
                                ids.splice(to, 0, ids.splice(from, 1)[0]!);
                                void reorderSectionsCommand(course.id, ids);
                                setDraggedSectionId(null);
                              }}
                              className="group/section flex items-center"
                            >
                              <button
                                type="button"
                                className={cn(
                                  rowClass,
                                  'min-w-0 flex-1 text-[12px]',
                                  sameView(view, target)
                                    ? 'bg-[var(--nb-accent-soft)] text-[var(--nb-accent)]'
                                    : 'text-nb-text-2 hover:bg-[var(--nb-hover)]',
                                )}
                                onClick={() => setView(target)}
                                onDoubleClick={() => setEditingSection(section)}
                              >
                                <span className="truncate">{section.name}</span>
                              </button>
                              <button
                                type="button"
                                aria-label={t('common.delete')}
                                className="hidden size-6 place-items-center text-nb-text-3 group-hover/section:grid"
                                onClick={() => {
                                  if (
                                    window.confirm(t('organization.deleteSectionConfirm'))
                                  )
                                    void deleteSectionCommand(section);
                                }}
                              >
                                <X size={11} />
                              </button>
                            </li>
                          );
                        })}
                        <li>
                          <button
                            type="button"
                            className={`${rowClass} text-[12px] text-nb-text-3 hover:bg-[var(--nb-hover)]`}
                            onClick={() => setSectionCourseId(course.id)}
                          >
                            <Plus size={11} />
                            {t('organization.newSection')}
                          </button>
                        </li>
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </SidebarSection>

        <SidebarSection
          title={t('sidebar.tags')}
          action={
            <GlassIconButton
              label={t('organization.tagManager')}
              className="size-6"
              onClick={() => setTagManagerOpen(true)}
            >
              <Settings2 size={12} />
            </GlassIconButton>
          }
        >
          <ul className="flex flex-col gap-0.5">
            {tags.map((tag) => {
              const target: ViewKind = { kind: 'tag', tagId: tag.id };
              return (
                <li key={tag.id}>
                  <button
                    type="button"
                    className={cn(
                      rowClass,
                      sameView(view, target)
                        ? 'bg-[var(--nb-accent-soft)] text-[var(--nb-accent)]'
                        : 'text-nb-text-2 hover:bg-[var(--nb-hover)]',
                    )}
                    onClick={() => setView(target)}
                  >
                    <Tags size={12} />
                    <span className="truncate">
                      {tag.namespace ? `${tag.namespace}:` : ''}
                      {tag.name}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </SidebarSection>

        <SidebarSection title={t('sidebar.savedSearches')}>
          <ul className="flex flex-col gap-0.5">
            {savedSearches.map((search) => {
              const target: ViewKind = { kind: 'savedSearch', savedSearchId: search.id };
              return (
                <li key={search.id} className="group/search flex items-center">
                  <button
                    type="button"
                    className={cn(
                      rowClass,
                      'min-w-0 flex-1',
                      sameView(view, target)
                        ? 'bg-[var(--nb-accent-soft)] text-[var(--nb-accent)]'
                        : 'text-nb-text-2 hover:bg-[var(--nb-hover)]',
                    )}
                    onClick={() => setView(target)}
                  >
                    <Search size={12} />
                    <span className="truncate">{search.name}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={t('common.delete')}
                    className="hidden size-6 place-items-center text-nb-text-3 group-hover/search:grid"
                    onClick={() => void deleteSavedSearchCommand(search.id)}
                  >
                    <X size={11} />
                  </button>
                  <button
                    type="button"
                    aria-label={t('organization.editSavedSearch')}
                    className="hidden size-6 place-items-center text-nb-text-3 group-hover/search:grid"
                    onClick={() => setEditingSearch(search)}
                  >
                    <Settings2 size={11} />
                  </button>
                </li>
              );
            })}
          </ul>
        </SidebarSection>

        <SidebarSection
          title={t('organization.templates')}
          action={
            <GlassIconButton
              label={t('organization.saveAsTemplate')}
              className="size-6"
              disabled={!note}
              onClick={() => setTemplateNameOpen(true)}
            >
              <Plus size={13} />
            </GlassIconButton>
          }
        >
          <ul className="flex flex-col gap-0.5">
            {templates.map((template) => (
              <li key={template.id} className="group/template flex items-center">
                <button
                  type="button"
                  className={`${rowClass} min-w-0 flex-1 text-nb-text-2 hover:bg-[var(--nb-hover)]`}
                  onClick={() => void openTemplate(template.id)}
                >
                  <FileStack size={12} />
                  <span className="truncate">{template.name}</span>
                </button>
                <button
                  type="button"
                  aria-label={t('common.delete')}
                  className="hidden size-6 place-items-center text-nb-text-3 group-hover/template:grid"
                  onClick={() => void deleteTemplateCommand(template.id)}
                >
                  <X size={11} />
                </button>
              </li>
            ))}
          </ul>
        </SidebarSection>
      </nav>

      <CourseDialog
        open={courseDialog !== null}
        course={courseDialog === 'new' ? null : courseDialog}
        onClose={() => setCourseDialog(null)}
      />
      <TagManagerDialog open={tagManagerOpen} onClose={() => setTagManagerOpen(false)} />
      <NameDialog
        open={templateNameOpen}
        label={t('organization.saveAsTemplate')}
        initialValue={note?.title ?? ''}
        onClose={() => setTemplateNameOpen(false)}
        onSubmit={async (name) => {
          if (!note) return;
          const result = await saveNoteAsTemplateCommand(note, name, false);
          if (result.ok) setTemplateNameOpen(false);
        }}
      />
      <SavedSearchDialog search={editingSearch} onClose={() => setEditingSearch(null)} />
      <NameDialog
        open={editingSection !== null}
        label={t('organization.editSection')}
        initialValue={editingSection?.name}
        onClose={() => setEditingSection(null)}
        onSubmit={async (name) => {
          if (!editingSection) return;
          const result = await updateSectionCommand({ ...editingSection, name });
          if (result.ok) setEditingSection(null);
        }}
      />
      <NameDialog
        open={sectionCourseId !== null}
        label={t('organization.newSection')}
        onClose={() => setSectionCourseId(null)}
        onSubmit={async (name) => {
          if (!sectionCourseId) return;
          const result = await createSectionCommand({ courseId: sectionCourseId, name });
          if (result.ok) {
            setSectionCourseId(null);
            setExpanded((current) => new Set(current).add(result.value.courseId));
          }
        }}
      />
    </>
  );
}

function SidebarSection({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-1 flex min-h-6 items-center justify-between px-2">
        <h2 className="text-[12px] font-semibold uppercase tracking-wide text-nb-text-3">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}
