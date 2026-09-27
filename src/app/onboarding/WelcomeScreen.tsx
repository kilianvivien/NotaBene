/**
 * The welcome screen: what NotaBene does, and how to begin.
 *
 * Asked once, of an empty library. Someone arriving with an Obsidian vault or
 * a Notion export should spend their first minute importing it, not deleting
 * a sample course — so bringing a library is the primary action here, beside
 * the starter material rather than behind a menu (plan §20 item 2). Help →
 * Welcome to NotaBene reopens it as a tour, where only the import remains.
 *
 * The tour is drawn from the app's own tokens rather than screenshots, so it
 * follows the theme and the accent the student picked, and every word in it is
 * translated. Dismissing the first run decides nothing: the question returns
 * at the next launch while the library is still empty.
 */
import {
  Bell,
  CalendarDays,
  Check,
  ChevronRight,
  FileText,
  FolderInput,
  FolderTree,
  Inbox,
  Info,
  KeyRound,
  ListChecks,
  MessageCircleQuestion,
  Pause,
  PenLine,
  Play,
  Podcast,
  Repeat,
  Search,
  Sparkles,
  Network,
  Layers,
  type LucideIcon,
} from 'lucide-react';
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { GlassButton, ModalOverlay } from '@/components/glass';
import { runOnboardingCommand, skipOnboardingCommand } from '@/lib/commands';
import { useUiStore } from '@/lib/state/uiStore';
import { cn } from '@/lib/utils/cn';
import './welcome.css';

const FEATURES = ['write', 'organize', 'find', 'study', 'plan', 'ask'] as const;
type Feature = (typeof FEATURES)[number];

const FEATURE_ICONS: Record<Feature, LucideIcon> = {
  write: PenLine,
  organize: FolderTree,
  find: Search,
  study: Layers,
  plan: ListChecks,
  ask: MessageCircleQuestion,
};

/** Long enough for each scene to finish drawing and be read once. Kept in
 * step with `--wl-scene` in `welcome.css`, which times the progress rule. */
const SCENE_MS = 6500;

function reducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

type Busy = 'import' | 'sample' | 'empty' | null;

export function WelcomeScreen() {
  const { t } = useTranslation();
  const mode = useUiStore((state) => state.welcome);
  const setWelcome = useUiStore((state) => state.setWelcome);
  const setSourceImportOpen = useUiStore((state) => state.setSourceImportOpen);
  const [feature, setFeature] = useState<Feature>('write');
  // Hovering or focusing the tour holds the scene; the button holds it for
  // good. Nobody who asked for less motion gets an autoplay at all.
  const [held, setHeld] = useState(false);
  const [paused, setPaused] = useState(reducedMotion);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState('');
  const tabs = useRef<HTMLDivElement>(null);
  const open = mode !== null;
  const playing = open && !held && !paused;

  useEffect(() => {
    if (!open) return;
    setFeature('write');
    setError('');
  }, [open]);

  useEffect(() => {
    if (!playing) return;
    const timer = window.setTimeout(() => {
      setFeature(
        (current) => FEATURES[(FEATURES.indexOf(current) + 1) % FEATURES.length]!,
      );
    }, SCENE_MS);
    return () => window.clearTimeout(timer);
  }, [playing, feature]);

  function close() {
    if (busy) return;
    setWelcome(null);
  }

  async function begin(choice: Exclude<Busy, null>) {
    if (mode === 'revisit') {
      setWelcome(null);
      if (choice === 'import') setSourceImportOpen(true);
      return;
    }
    setBusy(choice);
    setError('');
    const result =
      choice === 'sample' ? await runOnboardingCommand() : await skipOnboardingCommand();
    setBusy(null);
    if (!result.ok) {
      setError(t('welcome.failed'));
      return;
    }
    setWelcome(null);
    if (choice === 'import') setSourceImportOpen(true);
  }

  function onTabKey(event: KeyboardEvent<HTMLDivElement>) {
    const step =
      event.key === 'ArrowDown' || event.key === 'ArrowRight'
        ? 1
        : event.key === 'ArrowUp' || event.key === 'ArrowLeft'
          ? -1
          : 0;
    if (!step) return;
    event.preventDefault();
    const next =
      FEATURES[(FEATURES.indexOf(feature) + step + FEATURES.length) % FEATURES.length]!;
    setFeature(next);
    tabs.current?.querySelector<HTMLElement>(`[data-feature="${next}"]`)?.focus();
  }

  return (
    <ModalOverlay
      open={open}
      onClose={close}
      label={t('welcome.label')}
      placement="center"
      className="nb-welcome max-w-[960px]"
    >
      <div className="wl-body">
        <section className="wl-intro">
          <p className="wl-eyebrow wl-rise" style={{ '--wl-i': 0 } as CSSProperties}>
            <img src="/icon-192.png" alt="" className="wl-icon" width={30} height={30} />
            {t('welcome.eyebrow')}
          </p>
          <h2 className="wl-headline wl-rise" style={{ '--wl-i': 2 } as CSSProperties}>
            {t('welcome.headline')}
          </h2>
          <p className="wl-lead wl-rise" style={{ '--wl-i': 3 } as CSSProperties}>
            {t('welcome.lead')}
          </p>

          <div
            ref={tabs}
            role="tablist"
            aria-label={t('welcome.tourLabel')}
            aria-orientation="vertical"
            className="wl-tabs wl-rise"
            style={{ '--wl-i': 4 } as CSSProperties}
            onKeyDown={onTabKey}
            onMouseEnter={() => setHeld(true)}
            onMouseLeave={() => setHeld(false)}
          >
            {FEATURES.map((id) => {
              const Icon = FEATURE_ICONS[id];
              const selected = id === feature;
              return (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  id={`wl-tab-${id}`}
                  aria-labelledby={`wl-tab-${id}-title`}
                  aria-selected={selected}
                  aria-controls="wl-stage"
                  tabIndex={selected ? 0 : -1}
                  data-feature={id}
                  className={cn('wl-tab', selected && 'is-selected')}
                  onClick={() => setFeature(id)}
                >
                  <span className="wl-tab-icon">
                    <Icon size={15} aria-hidden />
                  </span>
                  <span className="wl-tab-text">
                    <span id={`wl-tab-${id}-title`} className="wl-tab-title">
                      {t(`welcome.features.${id}.title`)}
                    </span>
                    <span className="wl-tab-description">
                      {t(`welcome.features.${id}.description`)}
                    </span>
                  </span>
                  {selected && (
                    <span
                      key={`${id}-${playing}`}
                      aria-hidden
                      className={cn('wl-progress', playing && 'is-running')}
                    />
                  )}
                </button>
              );
            })}
          </div>
        </section>

        <section
          className="wl-stage-wrap wl-rise"
          style={{ '--wl-i': 3 } as CSSProperties}
          onMouseEnter={() => setHeld(true)}
          onMouseLeave={() => setHeld(false)}
        >
          <div
            id="wl-stage"
            role="tabpanel"
            aria-labelledby={`wl-tab-${feature}`}
            className="wl-stage"
          >
            {/* Keyed, so every visit replays the scene from its first frame. */}
            <Scene key={feature} feature={feature} />
          </div>
          <button
            type="button"
            className="wl-playback"
            aria-label={paused ? t('welcome.play') : t('welcome.pause')}
            title={paused ? t('welcome.play') : t('welcome.pause')}
            onClick={() => setPaused((value) => !value)}
          >
            {paused ? <Play size={12} aria-hidden /> : <Pause size={12} aria-hidden />}
          </button>
        </section>
      </div>

      <footer className="wl-footer">
        <p className="wl-footer-note">
          {error ? (
            <span role="alert" className="wl-error">
              {error}
            </span>
          ) : (
            t('welcome.import.description')
          )}
        </p>
        {mode === 'firstRun' ? (
          <>
            <GlassButton
              size="sm"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => void begin('empty')}
            >
              {t('welcome.empty')}
            </GlassButton>
            <GlassButton
              size="sm"
              disabled={busy !== null}
              onClick={() => void begin('sample')}
            >
              {t('welcome.sample')}
            </GlassButton>
          </>
        ) : (
          <GlassButton size="sm" onClick={close}>
            {t('welcome.close')}
          </GlassButton>
        )}
        <GlassButton
          size="sm"
          variant="accent"
          data-autofocus
          disabled={busy !== null}
          onClick={() => void begin('import')}
        >
          <FolderInput size={14} aria-hidden />
          {t('welcome.import.title')}
        </GlassButton>
      </footer>
    </ModalOverlay>
  );
}

/** The search result's title with what was typed marked, as the real list does. */
function highlight(text: string, query: string): ReactNode {
  const at = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (at < 0 || !query) return text;
  return (
    <>
      {text.slice(0, at)}
      <mark>{text.slice(at, at + query.length)}</mark>
      {text.slice(at + query.length)}
    </>
  );
}

/** When a step of a scene starts, as the custom property `welcome.css` reads. */
function at(seconds: number): CSSProperties {
  return { '--wl-d': `${seconds}s` } as CSSProperties;
}

const PHYSICS = '#3478c7';

/** One short vignette per feature, each a faithful miniature of the real
 * surface: the editor's blocks, the sidebar's shape, tags as `tagLabel`
 * prints them, a deck as flashcards are saved into a note. Each is plain
 * markup whose animation lives in `welcome.css`; under reduced motion it is
 * simply the finished picture. */
function Scene({ feature }: { feature: Feature }) {
  const { t } = useTranslation();
  const s = (key: string) => t(`welcome.scene.${key}`);

  switch (feature) {
    case 'write':
      return (
        <div className="wl-scene">
          <div className="wl-page">
            <p className="wl-crumb">
              <span className="wl-dot" style={{ background: PHYSICS }} />
              {s('course')} › {s('week')}
            </p>
            <h3 className="wl-note-title">
              <span className="wl-type">{s('noteTitle')}</span>
            </h3>
            <p className="wl-note-text wl-step" style={at(1.2)}>
              {s('noteText')} <span className="wl-link">{s('link')}</span>.
            </p>
            <div className="wl-callout wl-step" style={at(1.9)}>
              <Info size={13} aria-hidden />
              <span>
                <mark className="wl-mark">{s('callout')}</mark>
              </span>
            </div>
            <div className="wl-map wl-step" style={at(2.8)} aria-hidden>
              <svg viewBox="0 0 320 92" preserveAspectRatio="none">
                <path className="wl-edge" d="M160 24 C160 46 60 44 60 64" />
                <path className="wl-edge" d="M160 24 L160 64" />
                <path className="wl-edge" d="M160 24 C160 46 260 44 260 64" />
              </svg>
              <span className="wl-node is-root">{s('mapRoot')}</span>
              <span className="wl-node is-leaf wl-pop" style={at(3.3)}>
                {s('mapA')}
              </span>
              <span className="wl-node is-leaf wl-pop" style={at(3.45)}>
                {s('mapB')}
              </span>
              <span className="wl-node is-leaf wl-pop" style={at(3.6)}>
                {s('mapC')}
              </span>
            </div>
          </div>
        </div>
      );

    case 'organize':
      return (
        <div className="wl-scene wl-organize">
          <div className="wl-mini-sidebar">
            <p className="wl-side-row">
              <Inbox size={13} aria-hidden />
              {s('inbox')}
              <span className="wl-count" aria-hidden>
                <span className="wl-count-before">1</span>
              </span>
            </p>
            <p className="wl-side-heading">{s('courses')}</p>
            <p className="wl-side-row">
              <span className="wl-dot" style={{ background: PHYSICS }} />
              {s('course')}
            </p>
            <p className="wl-side-row is-section wl-target">{s('week')}</p>
            <p className="wl-side-row">
              <span className="wl-dot" style={{ background: '#4b7c58' }} />
              {s('courseB')}
            </p>
            <p className="wl-side-row">
              <span className="wl-dot" style={{ background: '#7d5aa8' }} />
              {s('courseC')}
            </p>
          </div>
          <div className="wl-cards">
            <div className="wl-card wl-card-fly">
              <p className="wl-card-title">{s('noteTitle')}</p>
              <p className="wl-card-meta">
                <span className="wl-dot" style={{ background: PHYSICS }} />
                {s('course')} › {s('week')}
              </p>
              <p className="wl-tags">
                <span className="wl-tag wl-pop" style={at(2.2)}>
                  {t('tags.facet_exam')} · {s('tagExam')}
                </span>
                <span className="wl-tag wl-pop" style={at(2.4)}>
                  {t('tags.facet_topic')} · {s('tagTopic')}
                </span>
              </p>
            </div>
            <div className="wl-card is-ghost" />
            <div className="wl-card is-ghost" />
          </div>
        </div>
      );

    case 'find':
      return (
        <div className="wl-scene">
          <div className="wl-search">
            <Search size={14} aria-hidden />
            <span className="wl-type wl-type-short">{s('query')}</span>
            <kbd className="wl-kbd">⌘K</kbd>
          </div>
          <ul className="wl-results">
            {(['resultA', 'resultB', 'resultC'] as const).map((key, index) => (
              <li key={key} className="wl-result wl-step" style={at(1.1 + index * 0.15)}>
                <FileText size={13} aria-hidden />
                <span className="wl-result-title">{highlight(s(key), s('query'))}</span>
                <span className="wl-result-meta">{s('course')}</span>
              </li>
            ))}
          </ul>
        </div>
      );

    case 'study':
      return (
        <div className="wl-scene wl-study">
          <div className="wl-page is-compact">
            <h3 className="wl-deck-title">{s('deckTitle')}</h3>
            <div className="wl-flashcard wl-step" style={at(0.4)}>
              <p className="wl-question">{s('cardFront')}</p>
              <p className="wl-toggle is-opening">
                <ChevronRight size={13} aria-hidden className="wl-chevron" />
                {s('answerLabel')}
              </p>
              <div className="wl-answer">
                <p>{s('cardBack')}</p>
              </div>
            </div>
            <div className="wl-flashcard wl-step" style={at(0.6)}>
              <p className="wl-question">{s('cardFront2')}</p>
              <p className="wl-toggle">
                <ChevronRight size={13} aria-hidden className="wl-chevron" />
                {s('answerLabel')}
              </p>
            </div>
          </div>
          <p className="wl-tools">
            {(
              [
                ['studyAnki', Layers],
                ['studyMap', Network],
                ['studyPodcast', Podcast],
              ] as const
            ).map(([key, Icon], index) => (
              <span key={key} className="wl-pill wl-pop" style={at(2.6 + index * 0.15)}>
                <Icon size={12} aria-hidden />
                {s(key)}
              </span>
            ))}
          </p>
        </div>
      );

    case 'plan':
      return (
        <div className="wl-scene wl-plan">
          <ul className="wl-tasks">
            {(
              [
                ['taskA', 'dueA', Bell],
                ['taskB', 'dueB', null],
                ['taskC', 'dueC', Repeat],
              ] as const
            ).map(([task, due, Icon], index) => (
              <li
                key={task}
                className={cn('wl-task wl-step', index === 1 && 'is-done')}
                style={at(0.3 + index * 0.15)}
              >
                <span className="wl-check">
                  <Check size={11} aria-hidden />
                </span>
                <span className="wl-task-title">{s(task)}</span>
                {Icon ? (
                  <Icon size={12} aria-hidden className="wl-task-icon" />
                ) : (
                  <span />
                )}
                <span className="wl-due">{s(due)}</span>
              </li>
            ))}
          </ul>
          <div className="wl-calendar" aria-hidden>
            <span className="wl-calendar-month">{s('calendarMonth')}</span>
            <span className="wl-calendar-day">14</span>
            <span className="wl-calendar-file">
              <CalendarDays size={11} />
              .ics
            </span>
          </div>
        </div>
      );

    case 'ask':
      return (
        <div className="wl-scene wl-ask">
          <p className="wl-bubble is-question wl-step" style={at(0.3)}>
            {s('question')}
          </p>
          <div className="wl-bubble is-answer wl-step" style={at(1.1)}>
            <Sparkles size={13} aria-hidden className="wl-spark" />
            <p className="wl-answer-text">{s('answer')}</p>
            <p className="wl-sources">
              <span className="wl-pill wl-pop" style={at(2.3)}>
                <FileText size={11} aria-hidden />
                {s('noteTitle')}
              </span>
              <span className="wl-pill wl-pop" style={at(2.45)}>
                <FileText size={11} aria-hidden />
                {s('resultC')}
              </span>
            </p>
          </div>
          <p className="wl-provider wl-step" style={at(3)}>
            <KeyRound size={12} aria-hidden />
            {s('provider')}
          </p>
        </div>
      );
  }
}
