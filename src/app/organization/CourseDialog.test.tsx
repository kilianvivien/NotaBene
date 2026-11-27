import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCourseCommand, updateCourseCommand } from '@/lib/commands';
import { createCourse, type Course } from '@/lib/schema';
import { useLibraryStore } from '@/lib/state/libraryStore';
import i18n from '@/lib/i18n';
import { CourseDialog } from './OrganizationModals';

vi.mock('@/lib/commands', () => ({
  createCourseCommand: vi.fn(),
  updateCourseCommand: vi.fn(),
  deleteCourseCommand: vi.fn(),
  deleteTagCommand: vi.fn(),
  ensureTagCommand: vi.fn(),
  mergeTagsCommand: vi.fn(),
  saveSearchCommand: vi.fn(),
  updateTagCommand: vi.fn(),
}));

beforeEach(async () => {
  vi.clearAllMocks();
  // Only the clock: `createMeeting` starts on today's weekday, and a test that
  // passes on Wednesdays only is no test. 2026-09-09 is a Wednesday.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 8, 9, 12));
  await i18n.changeLanguage('en');
  useLibraryStore.setState({ templates: [] });
  vi.mocked(updateCourseCommand).mockImplementation(async (course: Course) => ({
    ok: true,
    value: course,
  }));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function addMeeting() {
  fireEvent.click(screen.getByRole('button', { name: 'Add a session' }));
}

describe('CourseDialog timetable', () => {
  it('saves a new session as one dated meeting, normalized', async () => {
    const course = createCourse({ name: 'Algebra' });
    const onClose = vi.fn();
    render(<CourseDialog open course={course} onClose={onClose} />);
    expect(screen.getByText(/No timetable\./)).toBeTruthy();

    addMeeting();
    // A session meets on its own date; there is nothing to tick.
    expect(screen.queryByRole('button', { name: 'Friday' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-09-11' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Session title' }), {
      target: { value: '  Groups and rings  ' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Room' }), {
      target: { value: '  Amphi B  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(updateCourseCommand).toHaveBeenCalledOnce();
    const saved = vi.mocked(updateCourseCommand).mock.calls[0]![0];
    expect(saved.id).toBe(course.id);
    expect(saved.meetings).toEqual([
      expect.objectContaining({
        title: 'Groups and rings',
        // 2026-09-11 is a Friday, whatever weekday the session was added on.
        weekdays: [5],
        start: 10 * 60,
        end: 11 * 60 + 30,
        location: 'Amphi B',
        from: '2026-09-11',
        until: '2026-09-11',
        skip: [],
        templateId: null,
      }),
    ]);
    expect(saved).toMatchObject({ lectureRecording: 'ask', lectureNotify: false });
  });

  it('repeats a session weekly, and back to one session', async () => {
    const course = createCourse({ name: 'Algebra' });
    const onClose = vi.fn();
    render(<CourseDialog open course={course} onClose={onClose} />);
    addMeeting();
    const repeat = screen.getByRole('checkbox', { name: 'Repeat weekly' });

    fireEvent.click(repeat);
    // The series starts on the session's own day, for a semester.
    expect(
      screen.getByRole('button', { name: 'Wednesday' }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(screen.getByLabelText<HTMLInputElement>('Until').value).toBe('2026-12-22');
    fireEvent.click(screen.getByRole('button', { name: 'Friday' }));
    fireEvent.click(screen.getByRole('button', { name: 'Monday' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(vi.mocked(updateCourseCommand).mock.calls[0]![0].meetings).toEqual([
      expect.objectContaining({
        weekdays: [1, 3, 5],
        from: '2026-09-09',
        until: '2026-12-22',
      }),
    ]);

    fireEvent.click(repeat);
    expect(screen.queryByRole('button', { name: 'Friday' })).toBeNull();
    expect(screen.queryByLabelText('Until')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(updateCourseCommand).toHaveBeenCalledTimes(2));
    expect(vi.mocked(updateCourseCommand).mock.calls[1]![0].meetings).toEqual([
      expect.objectContaining({
        weekdays: [3],
        from: '2026-09-09',
        until: '2026-09-09',
        skip: [],
      }),
    ]);
  });

  it('folds past sessions behind one line, and shows each as a summary', () => {
    const course = createCourse({ name: 'Algebra' });
    const session = (id: string, day: string, title: string | null = null) => ({
      id,
      title,
      weekdays: [new Date(`${day}T12:00`).getDay()],
      start: 9 * 60,
      end: 10 * 60,
      location: null,
      from: day,
      until: day,
      skip: [],
      templateId: null,
      importKey: null,
    });
    render(
      <CourseDialog
        open
        course={{
          ...course,
          meetings: [
            session('00000000-0000-4000-8000-000000000003', '2026-09-14', 'Rings'),
            session('00000000-0000-4000-8000-000000000001', '2026-09-01', 'Groups'),
            session('00000000-0000-4000-8000-000000000002', '2026-09-02'),
          ],
        }}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('Rings')).toBeTruthy();
    expect(screen.queryByText('Groups')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '2 past sessions' }));
    expect(screen.getByText('Groups')).toBeTruthy();

    // A summary opens into the session's fields.
    fireEvent.click(screen.getByRole('button', { name: /Edit session: .*Rings/ }));
    expect(
      screen.getByRole<HTMLInputElement>('textbox', { name: 'Session title' }).value,
    ).toBe('Rings');
  });

  it('saves the lecture preferences with the course', async () => {
    const course = createCourse({ name: 'Algebra' });
    const onClose = vi.fn();
    render(<CourseDialog open course={course} onClose={onClose} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Always' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Notify when a lecture starts' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(vi.mocked(updateCourseCommand).mock.calls[0]![0]).toMatchObject({
      lectureRecording: 'always',
      lectureNotify: true,
    });
  });

  it('refuses a session that ends before it starts', async () => {
    const course = createCourse({ name: 'Algebra' });
    const onClose = vi.fn();
    const { baseElement } = render(
      <CourseDialog open course={course} onClose={onClose} />,
    );
    addMeeting();
    fireEvent.change(screen.getByLabelText('Ends'), { target: { value: '09:00' } });

    expect(screen.getByRole('alert').textContent).toBe(
      'The session must end after it starts.',
    );
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Confirm' }).disabled,
    ).toBe(true);
    // Whatever submits the form without the button still meets the guard.
    const form = baseElement.querySelector('form');
    fireEvent.submit(form!);
    await Promise.resolve();
    expect(updateCourseCommand).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('creates a new course bare, then writes its meetings as an update', async () => {
    const created = createCourse({ name: 'Optics' });
    vi.mocked(createCourseCommand).mockResolvedValue({ ok: true, value: created });
    const onClose = vi.fn();
    render(<CourseDialog open course={null} onClose={onClose} />);

    fireEvent.change(screen.getByRole('textbox', { name: 'Course name' }), {
      target: { value: 'Optics' },
    });
    addMeeting();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(createCourseCommand).toHaveBeenCalledOnce();
    expect(vi.mocked(createCourseCommand).mock.calls[0]![0]).not.toHaveProperty(
      'meetings',
    );
    expect(updateCourseCommand).toHaveBeenCalledWith({
      ...created,
      meetings: [expect.objectContaining({ weekdays: [3], location: null })],
      lectureRecording: 'ask',
      lectureNotify: false,
    });
  });

  it('creates a new course with no timetable in one write', async () => {
    const created = createCourse({ name: 'Optics' });
    vi.mocked(createCourseCommand).mockResolvedValue({ ok: true, value: created });
    const onClose = vi.fn();
    render(<CourseDialog open course={null} onClose={onClose} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Course name' }), {
      target: { value: 'Optics' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(updateCourseCommand).not.toHaveBeenCalled();
  });
});
