import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { GlassButton, ModalOverlay } from '@/components/glass';
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
  TAG_NAMESPACES,
  type Course,
  type SavedSearch,
  type Tag,
} from '@/lib/schema';
import { useLibraryStore } from '@/lib/state/libraryStore';

const field =
  'h-8 w-full rounded-nb-sm border border-[var(--nb-control-border)] bg-[var(--nb-control-bg)] px-2 text-[13px] focus:outline-none';
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
    <ModalOverlay
      open={open}
      onClose={onClose}
      label={course ? t('organization.editCourse') : t('sidebar.newCourse')}
      className="max-w-[520px]"
    >
      <form onSubmit={(event) => void submit(event)} className="p-5">
        <h2 className="mb-4 text-[17px] font-semibold">
          {course ? t('organization.editCourse') : t('sidebar.newCourse')}
        </h2>
        <div className="grid grid-cols-[72px_1fr] gap-3">
          <label className="text-[12px] text-nb-text-2">
            {t('organization.icon')}
            <input
              className={`${field} mt-1 text-center text-lg`}
              value={icon}
              maxLength={8}
              onChange={(event) => setIcon(event.target.value)}
            />
          </label>
          <label className="text-[12px] text-nb-text-2">
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
        <fieldset className="mt-3">
          <legend className="mb-1 text-[12px] text-nb-text-2">
            {t('organization.color')}
          </legend>
          <div className="flex gap-2">
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
        <fieldset className="mt-3">
          <legend className="mb-1 text-[12px] text-nb-text-2">
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
                className="grid size-9 place-items-center rounded-nb-sm border border-transparent text-lg hover:bg-[var(--nb-hover)] aria-pressed:border-[var(--nb-accent)] aria-pressed:bg-[var(--nb-accent-soft)]"
              >
                {candidate}
              </button>
            ))}
          </div>
        </fieldset>
        <div className="mt-3 grid grid-cols-2 gap-3">
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
        <div className="mt-5 flex justify-between">
          {course ? (
            <GlassButton
              variant="danger"
              size="sm"
              onClick={() => {
                if (!window.confirm(t('organization.deleteCourseConfirm'))) return;
                void deleteCourseCommand(course.id).then(() => onClose());
              }}
            >
              {t('common.delete')}
            </GlassButton>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <GlassButton size="sm" onClick={onClose}>
              {t('common.cancel')}
            </GlassButton>
            <GlassButton type="submit" size="sm" variant="accent">
              {t('common.confirm')}
            </GlassButton>
          </div>
        </div>
      </form>
    </ModalOverlay>
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
    <label className="text-[12px] text-nb-text-2">
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

  async function add(event: FormEvent) {
    event.preventDefault();
    const result = await ensureTagCommand({ name: name.trim(), namespace });
    if (result.ok) setName('');
  }

  return (
    <ModalOverlay open={open} onClose={onClose} label={t('organization.tagManager')}>
      <div className="p-5">
        <h2 className="text-[17px] font-semibold">{t('organization.tagManager')}</h2>
        <form
          onSubmit={(event) => void add(event)}
          className="my-4 grid grid-cols-[140px_1fr_auto] gap-2"
        >
          <select
            className={field}
            value={namespace ?? ''}
            onChange={(event) =>
              setNamespace((event.target.value || null) as Tag['namespace'])
            }
          >
            <option value="">{t('organization.freeTag')}</option>
            {TAG_NAMESPACES.map((value) => (
              <option key={value} value={value}>
                {value}:
              </option>
            ))}
          </select>
          <input
            className={field}
            value={name}
            required
            placeholder={t('organization.tagName')}
            onChange={(event) => setName(event.target.value)}
          />
          <GlassButton type="submit" size="sm" variant="accent">
            {t('organization.addTag')}
          </GlassButton>
        </form>
        <div className="max-h-[48vh] space-y-1 overflow-y-auto">
          {tags.map((tag) => (
            <TagRow key={tag.id} tag={tag} tags={tags} />
          ))}
        </div>
        <div className="mt-4 flex justify-end">
          <GlassButton size="sm" onClick={onClose}>
            {t('common.close')}
          </GlassButton>
        </div>
      </div>
    </ModalOverlay>
  );
}

function TagRow({ tag, tags }: { tag: Tag; tags: Tag[] }) {
  const { t } = useTranslation();
  const [name, setName] = useState(tag.name);
  const [mergeInto, setMergeInto] = useState('');
  return (
    <div className="grid grid-cols-[90px_1fr_120px_auto_auto] items-center gap-2 rounded-nb-sm bg-[var(--nb-control-bg)] p-2">
      <span className="truncate text-[12px] text-nb-text-3">
        {tag.namespace ? `${tag.namespace}:` : t('organization.freeTag')}
      </span>
      <input
        className={field}
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <select
        aria-label={t('organization.mergeInto')}
        className={field}
        value={mergeInto}
        onChange={(event) => setMergeInto(event.target.value)}
      >
        <option value="">{t('organization.mergeInto')}</option>
        {tags
          .filter((candidate) => candidate.id !== tag.id)
          .map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.namespace ? `${candidate.namespace}:` : ''}
              {candidate.name}
            </option>
          ))}
      </select>
      <GlassButton
        size="sm"
        disabled={!name.trim()}
        onClick={() => void updateTagCommand({ ...tag, name: name.trim() })}
      >
        {t('common.rename')}
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
    <ModalOverlay open={open} onClose={onClose} label={label} className="max-w-[420px]">
      <form
        className="p-5"
        onSubmit={(event) => {
          event.preventDefault();
          void onSubmit(value.trim());
        }}
      >
        <h2 className="mb-3 text-[17px] font-semibold">{label}</h2>
        <input
          className={field}
          autoFocus
          required
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <div className="mt-4 flex justify-end gap-2">
          <GlassButton size="sm" onClick={onClose}>
            {t('common.cancel')}
          </GlassButton>
          <GlassButton type="submit" size="sm" variant="accent">
            {t('common.confirm')}
          </GlassButton>
        </div>
      </form>
    </ModalOverlay>
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
    <ModalOverlay
      open={search !== null}
      onClose={onClose}
      label={t('organization.editSavedSearch')}
      className="max-w-[500px]"
    >
      <form
        className="p-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (!search) return;
          void saveSearchCommand({ id: search.id, name, query }).then((result) => {
            if (result.ok) onClose();
          });
        }}
      >
        <h2 className="mb-4 text-[17px] font-semibold">
          {t('organization.editSavedSearch')}
        </h2>
        <FormField label={t('organization.name')} value={name} onChange={setName} />
        <label className="mt-3 block text-[12px] text-nb-text-2">
          {t('organization.query')}
          <input
            className={`${field} mt-1`}
            value={query}
            required
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="mt-4 flex justify-end gap-2">
          <GlassButton size="sm" onClick={onClose}>
            {t('common.cancel')}
          </GlassButton>
          <GlassButton type="submit" size="sm" variant="accent">
            {t('common.confirm')}
          </GlassButton>
        </div>
      </form>
    </ModalOverlay>
  );
}
