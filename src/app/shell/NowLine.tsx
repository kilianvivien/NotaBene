/**
 * The Now line (plan §4 item 2): one row at the top of the sidebar while a
 * lecture is under way or within ten minutes of starting —
 * *Now · Droit constitutionnel · Amphi B · until 15:30* — and absent
 * otherwise, so a course without a timetable changes nothing.
 *
 * Clicking it is `lecture.start`: today's note for that session, created the
 * first time. It wraps to a second line rather than truncating, because a
 * session's own title ("Conférence « La corruption en France… »") is the part
 * worth reading.
 */
import { useTranslation } from 'react-i18next';
import { runAppCommand } from '@/lib/commands';
import { useLectureStore } from '@/lib/state/lectureStore';
import { describeOccurrence } from '@/lib/timetable/lectureClock';
import { minutesToTime } from '@/lib/timetable/meetings';
import { cn } from '@/lib/utils/cn';

export function NowLine() {
  const { t } = useTranslation();
  const current = useLectureStore((state) => state.current);
  const started = useLectureStore((state) => state.started);
  if (!current) return null;

  const lead = started
    ? t('lecture.now')
    : t('lecture.soon', { time: minutesToTime(current.meeting.start) });
  const text = `${lead} · ${describeOccurrence(current)}`;

  return (
    <button
      type="button"
      onClick={() => void runAppCommand('lecture.start')}
      title={t('lecture.open')}
      aria-label={`${text}. ${t('lecture.open')}`}
      className={cn(
        'flex w-full items-start gap-2 rounded-nb-xs px-2 py-1.5 text-left text-[12px] leading-snug',
        'bg-[var(--nb-accent-soft)] text-nb-text hover:bg-[var(--nb-hover)]',
        'transition-colors duration-[var(--nb-t-fast)]',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'mt-[5px] size-2 shrink-0 rounded-full',
          started && 'animate-pulse',
        )}
        style={{ backgroundColor: current.course.color }}
      />
      <span className="line-clamp-2 min-w-0">
        <span className="font-semibold text-[var(--nb-accent)]">{lead}</span>
        {' · '}
        {describeOccurrence(current)}
      </span>
    </button>
  );
}
