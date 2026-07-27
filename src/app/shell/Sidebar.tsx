import { useCallback, useState } from 'react';
import {
  Archive,
  ChevronDown,
  ChevronRight,
  FilePlus2,
  Files,
  FileStack,
  FolderPlus,
  Inbox,
  Pencil,
  Pin,
  Plus,
  Search,
  Settings2,
  Trash2,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ContextMenu, GlassIconButton, type ContextPoint } from '@/components/glass';
import { dialog } from '@/lib/adapters';
import {
  createNoteCommand,
  createNoteFromTemplateCommand,
  createSectionCommand,
  deleteCourseCommand,
  deleteSavedSearchCommand,
  deleteSectionCommand,
  deleteTagCommand,
  deleteTemplateCommand,
  emptyTrashCommand,
  fileNoteCommand,
  reorderCoursesCommand,
  reorderSectionsCommand,
  saveNoteAsTemplateCommand,
  trashNoteCommand,
  updateNoteCommand,
  updateSectionCommand,
} from '@/lib/commands';
import { tagLabel } from '@/lib/notes/tagLabel';
import type { Course, NoteTemplate, SavedSearch, Section, Tag } from '@/lib/schema';
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
import { endDrag, startDrag, useDropTarget } from './dnd';

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

/** How a row looks while an acceptable note is hovering over it. Deliberately
 * loud — a drop target you have to squint at is a drop target that gets missed,
 * and a mis-drop files a note somewhere the student will not look for it. */
const dropClass =
  'bg-[var(--nb-accent-soft)] text-[var(--nb-accent)] ring-1 ring-inset ring-[var(--nb-accent)]';

/** What each smart view does with a note dropped on it. `null` means the view
 * has no sensible answer — "all notes" is not a place. */
function smartViewDrop(view: ViewKind): ((noteId: string) => Promise<unknown>) | null {
  switch (view.kind) {
    case 'inbox':
      return (noteId) => fileNoteCommand(noteId, { courseId: null, sectionId: null });
    case 'pinned':
      return (noteId) => updateNoteCommand({ noteId, pinned: true });
    case 'archived':
      return (noteId) => updateNoteCommand({ noteId, archived: true });
    case 'trash':
      return (noteId) => trashNoteCommand(noteId);
    default:
      return null;
  }
}

type MenuState = { point: ContextPoint; render: () => React.ReactNode } | null;

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
  const [editingSearch, setEditingSearch] = useState<SavedSearch | null>(null);
  const [editingSection, setEditingSection] = useState<Section | null>(null);
  const [menu, setMenu] = useState<MenuState>(null);

  const closeMenu = useCallback(() => setMenu(null), []);

  async function confirmEmptyTrash() {
    const confirmed = await dialog.confirm(t('backups.emptyTrashConfirm'), {
      title: t('backups.emptyTrashTitle'),
      danger: true,
    });
    if (confirmed) await emptyTrashCommand();
  }

  const expand = useCallback(
    async (courseId: string) => {
      await refreshSections(courseId);
      setExpanded((current) => new Set(current).add(courseId));
    },
    [refreshSections],
  );

  async function toggleCourse(courseId: string) {
    if (expanded.has(courseId)) {
      setExpanded((current) => {
        const next = new Set(current);
        next.delete(courseId);
        return next;
      });
      return;
    }
    await expand(courseId);
  }

  async function openTemplate(templateId: string) {
    const template = templates.find((candidate) => candidate.id === templateId);
    if (!template) return;
    const result = await createNoteFromTemplateCommand(template);
    if (!result.ok) return;
    selectNote(result.value.id);
    await openNote(result.value.id);
  }

  async function newNoteIn(courseId: string, sectionId: string | null) {
    const result = await createNoteCommand({ courseId, sectionId });
    if (!result.ok) return;
    setView({ kind: 'course', courseId, ...(sectionId ? { sectionId } : {}) });
    selectNote(result.value.id);
    await openNote(result.value.id);
  }

  function openMenu(event: React.MouseEvent, render: () => React.ReactNode) {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ point: { x: event.clientX, y: event.clientY }, render });
  }

  return (
    <>
      <nav
        aria-label={t('sidebar.courses')}
        className="flex h-full w-full flex-col gap-4 overflow-y-auto border-r border-[var(--nb-divider)] bg-[var(--nb-sidebar-surface)] px-2 py-3"
      >
        <ul className="flex flex-col gap-0.5">
          {SMART_VIEWS.map((smart) => (
            <SmartViewRow
              key={smart.labelKey}
              smart={smart}
              current={view}
              onSelect={() => setView(smart.view)}
              onContextMenu={(event) => {
                if (smart.view.kind !== 'trash') return;
                openMenu(event, () => (
                  <ContextMenu
                    point={{ x: event.clientX, y: event.clientY }}
                    onClose={closeMenu}
                    header={t('sidebar.trash')}
                    items={[
                      {
                        id: 'empty',
                        label: t('backups.emptyTrash'),
                        icon: Trash2,
                        danger: true,
                        onSelect: () => void confirmEmptyTrash(),
                      },
                    ]}
                  />
                ));
              }}
            />
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
              {courses.map((course) => (
                <CourseRow
                  key={course.id}
                  course={course}
                  courses={courses}
                  sections={sections[course.id] ?? []}
                  open={expanded.has(course.id)}
                  current={view}
                  onToggle={() => void toggleCourse(course.id)}
                  onSelect={(target) => setView(target)}
                  onNoteDropped={() => void expand(course.id)}
                  onEdit={() => setCourseDialog(course)}
                  onEditSection={setEditingSection}
                  onNewSection={() => setSectionCourseId(course.id)}
                  onNewNote={(sectionId) => void newNoteIn(course.id, sectionId)}
                  onContextMenu={openMenu}
                  closeMenu={closeMenu}
                />
              ))}
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
              const label = tagLabel(tag, t);
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
                    onContextMenu={(event) =>
                      openMenu(event, () => (
                        <TagMenu
                          tag={tag}
                          point={{ x: event.clientX, y: event.clientY }}
                          onClose={closeMenu}
                          onManage={() => setTagManagerOpen(true)}
                        />
                      ))
                    }
                  >
                    <span
                      aria-hidden
                      className="size-2.5 shrink-0 rounded-full border border-black/10"
                      style={{ backgroundColor: tag.color }}
                    />
                    <span className="truncate" title={label.full}>
                      {label.facet && (
                        <span className="mr-1 text-[10.5px] uppercase tracking-wide text-nb-text-3">
                          {label.facet}
                        </span>
                      )}
                      {label.name}
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
                    onContextMenu={(event) =>
                      openMenu(event, () => (
                        <ContextMenu
                          point={{ x: event.clientX, y: event.clientY }}
                          onClose={closeMenu}
                          header={search.name}
                          items={[
                            {
                              id: 'edit',
                              label: t('organization.editSavedSearch'),
                              icon: Settings2,
                              onSelect: () => setEditingSearch(search),
                            },
                            null,
                            {
                              id: 'delete',
                              label: t('common.delete'),
                              icon: Trash2,
                              danger: true,
                              onSelect: () => void deleteSavedSearchCommand(search.id),
                            },
                          ]}
                        />
                      ))
                    }
                  >
                    <Search size={12} className="shrink-0" />
                    <span className="truncate">{search.name}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={t('organization.editSavedSearch')}
                    className="hidden size-6 shrink-0 place-items-center text-nb-text-3 group-hover/search:grid"
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
              <li key={template.id}>
                <button
                  type="button"
                  className={`${rowClass} min-w-0 text-nb-text-2 hover:bg-[var(--nb-hover)]`}
                  onClick={() => void openTemplate(template.id)}
                  onContextMenu={(event) =>
                    openMenu(event, () => (
                      <TemplateMenu
                        template={template}
                        point={{ x: event.clientX, y: event.clientY }}
                        onClose={closeMenu}
                        onUse={() => void openTemplate(template.id)}
                      />
                    ))
                  }
                >
                  <FileStack size={12} className="shrink-0" />
                  <span className="truncate">{template.name}</span>
                </button>
              </li>
            ))}
            {templates.length === 0 && (
              <li className="px-2 text-[12px] text-nb-text-3">
                {t('organization.noTemplates')}
              </li>
            )}
          </ul>
        </SidebarSection>
      </nav>

      {menu?.render()}

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
            await expand(result.value.courseId);
          }
        }}
      />
    </>
  );
}

// -- Rows --------------------------------------------------------------------

function SmartViewRow({
  smart,
  current,
  onSelect,
  onContextMenu,
}: {
  smart: SmartView;
  current: ViewKind;
  onSelect(): void;
  onContextMenu(event: React.MouseEvent): void;
}) {
  const { t } = useTranslation();
  const action = smartViewDrop(smart.view);
  const drop = useDropTarget({
    accepts: ['note'],
    disabled: action === null,
    onDrop: (_kind, noteId) => void action?.(noteId),
  });
  const selected = sameView(current, smart.view);
  const Icon = smart.icon;
  const destructive = smart.view.kind === 'trash';

  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        onContextMenu={onContextMenu}
        aria-current={selected ? 'page' : undefined}
        {...drop.handlers}
        className={cn(
          rowClass,
          drop.active
            ? destructive
              ? 'bg-[var(--nb-active)] text-[var(--nb-danger)] ring-1 ring-inset ring-[var(--nb-danger)]'
              : dropClass
            : selected
              ? 'bg-[var(--nb-accent-soft)] text-[var(--nb-accent)]'
              : 'text-nb-text-2 hover:bg-[var(--nb-hover)]',
        )}
      >
        <Icon size={14} className="shrink-0" />
        <span className="truncate">{t(smart.labelKey)}</span>
      </button>
    </li>
  );
}

function CourseRow({
  course,
  courses,
  sections,
  open,
  current,
  onToggle,
  onSelect,
  onNoteDropped,
  onEdit,
  onEditSection,
  onNewSection,
  onNewNote,
  onContextMenu,
  closeMenu,
}: {
  course: Course;
  courses: Course[];
  sections: Section[];
  open: boolean;
  current: ViewKind;
  onToggle(): void;
  onSelect(view: ViewKind): void;
  onNoteDropped(): void;
  onEdit(): void;
  onEditSection(section: Section): void;
  onNewSection(): void;
  onNewNote(sectionId: string | null): void;
  onContextMenu(event: React.MouseEvent, render: () => React.ReactNode): void;
  closeMenu(): void;
}) {
  const { t } = useTranslation();
  const courseView: ViewKind = { kind: 'course', courseId: course.id };
  const selected = sameView(current, courseView);

  const drop = useDropTarget({
    accepts: ['note', 'course'],
    onDrop: (kind, id) => {
      if (kind === 'course') {
        if (id === course.id) return;
        void reorderCoursesCommand(reordered(courses, id, course.id));
        return;
      }
      void fileNoteCommand(id, { courseId: course.id, sectionId: null });
      onNoteDropped();
    },
  });

  return (
    <li {...drop.handlers}>
      <div className="flex items-center">
        <button
          type="button"
          className="grid size-6 shrink-0 place-items-center text-nb-text-3"
          aria-label={open ? t('organization.collapse') : t('organization.expand')}
          aria-expanded={open}
          onClick={onToggle}
        >
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
        <button
          type="button"
          draggable
          onDragStart={(event) => startDrag(event, 'course', course.id, course.name)}
          onDragEnd={endDrag}
          onClick={() => onSelect(courseView)}
          onDoubleClick={onEdit}
          aria-current={selected ? 'page' : undefined}
          onContextMenu={(event) =>
            onContextMenu(event, () => (
              <ContextMenu
                point={{ x: event.clientX, y: event.clientY }}
                onClose={closeMenu}
                header={`${course.icon} ${course.name}`}
                items={[
                  {
                    id: 'note',
                    label: t('noteList.newNote'),
                    icon: FilePlus2,
                    onSelect: () => onNewNote(null),
                  },
                  {
                    id: 'section',
                    label: t('organization.newSection'),
                    icon: FolderPlus,
                    onSelect: onNewSection,
                  },
                  null,
                  {
                    id: 'edit',
                    label: t('organization.editCourse'),
                    icon: Pencil,
                    onSelect: onEdit,
                  },
                  null,
                  {
                    id: 'delete',
                    label: t('organization.deleteCourse'),
                    icon: Trash2,
                    danger: true,
                    onSelect: () => {
                      if (window.confirm(t('organization.deleteCourseConfirm'))) {
                        void deleteCourseCommand(course.id);
                      }
                    },
                  },
                ]}
              />
            ))
          }
          className={cn(
            rowClass,
            'min-w-0 flex-1 pl-1',
            drop.active
              ? dropClass
              : selected
                ? 'bg-[var(--nb-accent-soft)] text-[var(--nb-accent)]'
                : 'text-nb-text-2 hover:bg-[var(--nb-hover)]',
          )}
        >
          <span aria-hidden className="shrink-0">
            {course.icon}
          </span>
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
          {sections.map((section) => (
            <SectionRow
              key={section.id}
              section={section}
              sections={sections}
              current={current}
              onSelect={onSelect}
              onRename={() => onEditSection(section)}
              onNewNote={() => onNewNote(section.id)}
              onContextMenu={onContextMenu}
              closeMenu={closeMenu}
            />
          ))}
          <li>
            <button
              type="button"
              className={`${rowClass} text-[12px] text-nb-text-3 hover:bg-[var(--nb-hover)]`}
              onClick={onNewSection}
            >
              <Plus size={11} className="shrink-0" />
              <span className="truncate">{t('organization.newSection')}</span>
            </button>
          </li>
        </ul>
      )}
    </li>
  );
}

function SectionRow({
  section,
  sections,
  current,
  onSelect,
  onRename,
  onNewNote,
  onContextMenu,
  closeMenu,
}: {
  section: Section;
  sections: Section[];
  current: ViewKind;
  onSelect(view: ViewKind): void;
  onRename(): void;
  onNewNote(): void;
  onContextMenu(event: React.MouseEvent, render: () => React.ReactNode): void;
  closeMenu(): void;
}) {
  const { t } = useTranslation();
  const target: ViewKind = {
    kind: 'course',
    courseId: section.courseId,
    sectionId: section.id,
  };
  const selected = sameView(current, target);

  const drop = useDropTarget({
    accepts: ['note', 'section'],
    onDrop: (kind, id) => {
      if (kind === 'section') {
        if (id === section.id) return;
        void reorderSectionsCommand(
          section.courseId,
          reordered(sections, id, section.id),
        );
        return;
      }
      void fileNoteCommand(id, {
        courseId: section.courseId,
        sectionId: section.id,
      });
    },
  });

  return (
    <li className="group/section flex items-center" {...drop.handlers}>
      <button
        type="button"
        draggable
        onDragStart={(event) => startDrag(event, 'section', section.id, section.name)}
        onDragEnd={endDrag}
        className={cn(
          rowClass,
          'min-w-0 flex-1 text-[12px]',
          drop.active
            ? dropClass
            : selected
              ? 'bg-[var(--nb-accent-soft)] text-[var(--nb-accent)]'
              : 'text-nb-text-2 hover:bg-[var(--nb-hover)]',
        )}
        onClick={() => onSelect(target)}
        onDoubleClick={onRename}
        onContextMenu={(event) =>
          onContextMenu(event, () => (
            <ContextMenu
              point={{ x: event.clientX, y: event.clientY }}
              onClose={closeMenu}
              header={section.name}
              items={[
                {
                  id: 'note',
                  label: t('noteList.newNote'),
                  icon: FilePlus2,
                  onSelect: onNewNote,
                },
                {
                  id: 'rename',
                  label: t('organization.editSection'),
                  icon: Pencil,
                  onSelect: onRename,
                },
                null,
                {
                  id: 'delete',
                  label: t('organization.deleteSection'),
                  icon: Trash2,
                  danger: true,
                  onSelect: () => {
                    if (window.confirm(t('organization.deleteSectionConfirm'))) {
                      void deleteSectionCommand(section);
                    }
                  },
                },
              ]}
            />
          ))
        }
      >
        <span className="truncate">{section.name}</span>
      </button>
      <button
        type="button"
        aria-label={t('organization.deleteSection')}
        className="hidden size-6 shrink-0 place-items-center text-nb-text-3 group-hover/section:grid"
        onClick={() => {
          if (window.confirm(t('organization.deleteSectionConfirm'))) {
            void deleteSectionCommand(section);
          }
        }}
      >
        <X size={11} />
      </button>
    </li>
  );
}

function TagMenu({
  tag,
  point,
  onClose,
  onManage,
}: {
  tag: Tag;
  point: ContextPoint;
  onClose(): void;
  onManage(): void;
}) {
  const { t } = useTranslation();
  return (
    <ContextMenu
      point={point}
      onClose={onClose}
      header={tagLabel(tag, t).full}
      items={[
        {
          id: 'manage',
          label: t('organization.tagManager'),
          icon: Settings2,
          onSelect: onManage,
        },
        null,
        {
          id: 'delete',
          label: t('common.delete'),
          icon: Trash2,
          danger: true,
          onSelect: () => {
            if (window.confirm(t('organization.deleteTagConfirm'))) {
              void deleteTagCommand(tag.id);
            }
          },
        },
      ]}
    />
  );
}

function TemplateMenu({
  template,
  point,
  onClose,
  onUse,
}: {
  template: NoteTemplate;
  point: ContextPoint;
  onClose(): void;
  onUse(): void;
}) {
  const { t } = useTranslation();
  return (
    <ContextMenu
      point={point}
      onClose={onClose}
      header={template.name}
      items={[
        {
          id: 'use',
          label: t('organization.newFromTemplate'),
          icon: FilePlus2,
          onSelect: onUse,
        },
        null,
        {
          id: 'delete',
          label: t('common.delete'),
          icon: Trash2,
          danger: true,
          onSelect: () => void deleteTemplateCommand(template.id),
        },
      ]}
    />
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
      <div className="mb-1 flex min-h-6 items-center justify-between gap-1 px-2">
        <h2 className="min-w-0 truncate text-[12px] font-semibold uppercase tracking-wide text-nb-text-3">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/** Move `movedId` to where `targetId` currently sits. */
function reordered<T extends { id: string }>(
  items: T[],
  movedId: string,
  targetId: string,
): string[] {
  const ids = items.map((item) => item.id);
  const from = ids.indexOf(movedId);
  const to = ids.indexOf(targetId);
  if (from === -1 || to === -1) return ids;
  ids.splice(to, 0, ids.splice(from, 1)[0]!);
  return ids;
}
