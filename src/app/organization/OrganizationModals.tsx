import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, GlassButton, GlassSelect } from '@/components/glass';
import {
  createCourseCommand,
  deleteCourseCommand,
  deleteTagCommand,
  ensureTagCommand,
  mergeTagsCommand,
  saveSearchCommand,
  updateCourseCommand,
  updateTagCommand,
} from '@/lib/commands';
import {
  COURSE_COLORS,
  DEFAULT_TAG_COLOR,
  TAG_COLORS,
  TAG_NAMESPACES,
  type Course,
  type SavedSearch,
  type Tag,
} from '@/lib/schema';
import { tagLabel } from '@/lib/notes/tagLabel';
import { useLibraryStore } from '@/lib/state/libraryStore';

const field =
  'h-8 w-full rounded-nb-sm border border-[var(--nb-control-border)] bg-[var(--nb-control-surface)] px-2 text-[13px] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--nb-accent-ring)]';
const COURSE_ICONS = [
  '📘',
  '📐',
  '🧮',
  '🔬',
  '⚗️',
  '🧬',
  '🌍',
  '🏛️',
  '⚖️',
  '💻',
  '🎨',
  '🎵',
  '🗣️',
  '📚',
  '💡',
  '🧠',
] as const;

/** The footer sits outside the `<form>` element, so submit buttons reach it by
 * id. Native submission then still works, which is what makes Return in a text
 * field do the obvious thing. */
const COURSE_FORM = 'nb-course-form';
const NAME_FORM = 'nb-name-form';
const SAVED_SEARCH_FORM = 'nb-saved-search-form';

interface CourseDialogProps {
  open: boolean;
  course: Course | null;
  onClose(): void;
}

export function CourseDialog({ open, course, onClose }: CourseDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('📘');
  const [color, setColor] = useState<string>(COURSE_COLORS[0]);
  const [professor, setProfessor] = useState('');
  const [semester, setSemester] = useState('');
  const [credits, setCredits] = useState('');
  const [schedule, setSchedule] = useState('');

  useEffect(() => {
    if (!open) return;
    setName(course?.name ?? '');
    setIcon(course?.icon ?? '📘');
    setColor(course?.color ?? COURSE_COLORS[0]);
    setProfessor(course?.professor ?? '');
    setSemester(course?.semester ?? '');
    setCredits(course?.credits?.toString() ?? '');
    setSchedule(course?.schedule ?? '');
  }, [course, open]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const metadata = {
      name: name.trim(),
      icon: icon.trim() || '📘',
      color,
      professor: professor.trim() || undefined,
      semester: semester.trim() || undefined,
      credits: credits ? Number(credits) : undefined,
      schedule: schedule.trim() || undefined,
    };
    const result = course
      ? await updateCourseCommand({ ...course, ...metadata })
      : await createCourseCommand(metadata);
    if (result.ok) onClose();
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={course ? t('organization.editCourse') : t('sidebar.newCourse')}
      size="md"
      footer={
        <>
          {course && (
            <GlassButton
              variant="danger"
              size="sm"
              className="mr-auto"
              onClick={() => {
                if (!window.confirm(t('organization.deleteCourseConfirm'))) return;
                void deleteCourseCommand(course.id).then(() => onClose());
              }}
            >
              {t('common.delete')}
            </GlassButton>
          )}
          <GlassButton size="sm" onClick={onClose}>
            {t('common.cancel')}
          </GlassButton>
          <GlassButton form={COURSE_FORM} type="submit" size="sm" variant="accent">
            {t('common.confirm')}
          </GlassButton>
        </>
      }
    >
      <form id={COURSE_FORM} onSubmit={(event) => void submit(event)}>
        <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-3">
          <label className="text-[12px] text-nb-text-2">
            {t('organization.icon')}
            <input
              className={`${field} mt-1 text-center text-lg`}
              value={icon}
              maxLength={8}
              onChange={(event) => setIcon(event.target.value)}
            />
          </label>
          <label className="min-w-0 text-[12px] text-nb-text-2">
            {t('organization.courseName')}
            <input
              className={`${field} mt-1`}
              autoFocus
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
        </div>

        <fieldset className="mt-4">
          <legend className="mb-1.5 text-[12px] text-nb-text-2">
            {t('organization.color')}
          </legend>
          <div className="flex flex-wrap gap-2">
            {COURSE_COLORS.map((candidate) => (
              <button
                key={candidate}
                type="button"
                aria-label={candidate}
                aria-pressed={color === candidate}
                onClick={() => setColor(candidate)}
                className="size-6 rounded-full border-2 border-transparent aria-pressed:border-[var(--nb-text)]"
                style={{ backgroundColor: candidate }}
              />
            ))}
          </div>
        </fieldset>

        <fieldset className="mt-4">
          <legend className="mb-1.5 text-[12px] text-nb-text-2">
            {t('organization.iconPicker')}
          </legend>
          <div className="grid grid-cols-8 gap-1.5">
            {COURSE_ICONS.map((candidate) => (
              <button
                key={candidate}
                type="button"
                aria-label={candidate}
                aria-pressed={icon === candidate}
                onClick={() => setIcon(candidate)}
                className="grid aspect-square place-items-center rounded-nb-sm border border-transparent text-lg hover:bg-[var(--nb-hover)] aria-pressed:border-[var(--nb-accent)] aria-pressed:bg-[var(--nb-accent-soft)]"
              >
                {candidate}
              </button>
            ))}
          </div>
        </fieldset>

        <div className="mt-4 grid grid-cols-2 gap-3">
          <FormField
            label={t('organization.professor')}
            value={professor}
            onChange={setProfessor}
          />
          <FormField
            label={t('organization.semester')}
            value={semester}
            onChange={setSemester}
          />
          <FormField
            label={t('organization.credits')}
            value={credits}
            onChange={setCredits}
            type="number"
          />
          <FormField
            label={t('organization.schedule')}
            value={schedule}
            onChange={setSchedule}
          />
        </div>
      </form>
    </Dialog>
  );
}

function FormField({
  label,
  value,
  onChange,
  type = 'text',
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  type?: string;
}) {
  return (
    <label className="min-w-0 text-[12px] text-nb-text-2">
      {label}
      <input
        className={`${field} mt-1`}
        type={type}
        min={type === 'number' ? 0 : undefined}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

export function TagManagerDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const { t } = useTranslation();
  const tags = useLibraryStore((state) => state.tags);
  const [name, setName] = useState('');
  const [namespace, setNamespace] = useState<Tag['namespace']>(null);
  const [color, setColor] = useState(DEFAULT_TAG_COLOR);

  async function add(event: FormEvent) {
    event.preventDefault();
    const result = await ensureTagCommand({ name: name.trim(), namespace, color });
    if (result.ok) {
      setName('');
      setColor(DEFAULT_TAG_COLOR);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('organization.tagManager')}
      size="lg"
      footer={
        <GlassButton size="sm" onClick={onClose}>
          {t('common.close')}
        </GlassButton>
      }
    >
      <form
        onSubmit={(event) => void add(event)}
        className="mb-3 grid grid-cols-[140px_minmax(0,1fr)_auto_auto] items-end gap-2"
      >
        <GlassSelect
          label={t('organization.freeTag')}
          value={namespace ?? ''}
          onChange={(event) =>
            setNamespace((event.target.value || null) as Tag['namespace'])
          }
        >
          <option value="">{t('tags.free')}</option>
          {TAG_NAMESPACES.map((value) => (
            <option key={value} value={value}>
              {t(`tags.facet_${value}`)}
            </option>
          ))}
        </GlassSelect>
        <input
          className={field}
          value={name}
          required
          placeholder={t('organization.tagName')}
          onChange={(event) => setName(event.target.value)}
        />
        <TagColorPicker value={color} onChange={setColor} />
        <GlassButton type="submit" size="sm" variant="accent">
          {t('organization.addTag')}
        </GlassButton>
      </form>
      <div className="space-y-1">
        {tags.map((tag) => (
          <TagRow key={tag.id} tag={tag} tags={tags} />
        ))}
        {tags.length === 0 && (
          <p className="py-6 text-center text-[12px] text-nb-text-3">
            {t('organization.noTags')}
          </p>
        )}
      </div>
      <datalist id="notabene-tag-colors">
        {TAG_COLORS.map((color) => (
          <option key={color} value={color} />
        ))}
      </datalist>
    </Dialog>
  );
}

function TagRow({ tag, tags }: { tag: Tag; tags: Tag[] }) {
  const { t } = useTranslation();
  const [name, setName] = useState(tag.name);
  const [color, setColor] = useState(tag.color);
  const [mergeInto, setMergeInto] = useState('');
  return (
    <div className="grid grid-cols-[auto_82px_minmax(0,1fr)_140px_auto_auto] items-center gap-2 rounded-nb-sm bg-[var(--nb-inset-surface)] p-2">
      <TagColorPicker value={color} onChange={setColor} compact />
      <span className="truncate text-[12px] text-nb-text-3">
        {tag.namespace ? tagLabel(tag, t).facet : t('tags.free')}
      </span>
      <input
        aria-label={t('organization.tagName')}
        className={field}
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <GlassSelect
        label={t('organization.mergeInto')}
        value={mergeInto}
        onChange={(event) => setMergeInto(event.target.value)}
      >
        <option value="">{t('organization.mergeInto')}</option>
        {tags
          .filter((candidate) => candidate.id !== tag.id)
          .map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {tagLabel(candidate, t).full}
            </option>
          ))}
      </GlassSelect>
      <GlassButton
        size="sm"
        disabled={!name.trim() || (name.trim() === tag.name && color === tag.color)}
        onClick={() => void updateTagCommand({ ...tag, name: name.trim(), color })}
      >
        {t('common.save')}
      </GlassButton>
      <GlassButton
        size="sm"
        variant="ghost"
        onClick={() => {
          if (mergeInto) void mergeTagsCommand(tag.id, mergeInto);
          else if (window.confirm(t('organization.deleteTagConfirm')))
            void deleteTagCommand(tag.id);
        }}
      >
        {mergeInto ? t('organization.merge') : t('common.delete')}
      </GlassButton>
    </div>
  );
}

function TagColorPicker({
  value,
  onChange,
  compact = false,
}: {
  value: string;
  onChange(value: string): void;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <label
      className="relative inline-grid shrink-0 place-items-center"
      title={t('organization.tagColor')}
    >
      <span
        aria-hidden
        className={compact ? 'size-5 rounded-full border' : 'size-8 rounded-nb-sm border'}
        style={{ backgroundColor: value, borderColor: 'var(--nb-control-border)' }}
      />
      <input
        type="color"
        aria-label={t('organization.tagColor')}
        className="absolute inset-0 size-full cursor-pointer opacity-0"
        value={value}
        list="notabene-tag-colors"
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

export function NameDialog({
  open,
  label,
  initialValue = '',
  onClose,
  onSubmit,
}: {
  open: boolean;
  label: string;
  initialValue?: string;
  onClose(): void;
  onSubmit(value: string): void | Promise<void>;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState(initialValue);
  useEffect(() => {
    if (open) setValue(initialValue);
  }, [initialValue, open]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={label}
      size="sm"
      footer={
        <>
          <GlassButton size="sm" onClick={onClose}>
            {t('common.cancel')}
          </GlassButton>
          <GlassButton form={NAME_FORM} type="submit" size="sm" variant="accent">
            {t('common.confirm')}
          </GlassButton>
        </>
      }
    >
      <form
        id={NAME_FORM}
        onSubmit={(event) => {
          event.preventDefault();
          void onSubmit(value.trim());
        }}
      >
        <input
          aria-label={label}
          className={field}
          autoFocus
          required
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      </form>
    </Dialog>
  );
}

export function SavedSearchDialog({
  search,
  onClose,
}: {
  search: SavedSearch | null;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => {
    setName(search?.name ?? '');
    setQuery(search?.query ?? '');
  }, [search]);

  return (
    <Dialog
      open={search !== null}
      onClose={onClose}
      title={t('organization.editSavedSearch')}
      size="md"
      footer={
        <>
          <GlassButton size="sm" onClick={onClose}>
            {t('common.cancel')}
          </GlassButton>
          <GlassButton form={SAVED_SEARCH_FORM} type="submit" size="sm" variant="accent">
            {t('common.confirm')}
          </GlassButton>
        </>
      }
    >
      <form
        id={SAVED_SEARCH_FORM}
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!search) return;
          void saveSearchCommand({ id: search.id, name, query }).then((result) => {
            if (result.ok) onClose();
          });
        }}
      >
        <FormField label={t('organization.name')} value={name} onChange={setName} />
        <label className="block text-[12px] text-nb-text-2">
          {t('organization.query')}
          <input
            className={`${field} mt-1`}
            value={query}
            required
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </form>
    </Dialog>
  );
}
