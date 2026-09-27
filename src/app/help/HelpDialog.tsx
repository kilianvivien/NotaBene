/**
 * Help → NotaBene help.
 *
 * Short topics rather than a manual: an introduction, a handful of entries of
 * a sentence or two, and one thing worth knowing. Where a command does what
 * an entry describes, the entry runs it and shows its shortcut, read from
 * `appCommands.ts`, so the help can never name a key the app does not answer
 * to. The shortcut sheet is generated from `buildMenuBar` — the tree the
 * native menu bar is built from — so it is grouped as the menus are and
 * cannot drift into a second list (plan §20 item 5).
 */
import {
  ArrowUpRight,
  BookOpen,
  CalendarCheck,
  FolderInput,
  FolderTree,
  Keyboard,
  Layers,
  Lightbulb,
  Search,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { GlassButton, ModalOverlay } from '@/components/glass';
import { APP_COMMANDS, runAppCommand, type AppCommandId } from '@/lib/commands';
import type { MenuNode } from '@/lib/adapters';
import { useUiStore } from '@/lib/state/uiStore';
import { cn } from '@/lib/utils/cn';
import { buildMenuBar } from '../menuBar';
import { commandShortcut } from '../shell/useCommandSearch';
import './help.css';

interface Entry {
  id: string;
  /** The command that does this: the entry runs it and shows its shortcut. */
  command?: AppCommandId;
  /** Or what is typed in the editor, for things that are not commands. */
  keys?: string;
}

const TOPICS = {
  start: {
    icon: BookOpen,
    entries: [
      { id: 'note', command: 'note.new' },
      { id: 'quick', command: 'note.quick' },
      { id: 'blocks', keys: '/' },
      { id: 'links', keys: '[[' },
      { id: 'palette', command: 'app.commandPalette' },
      { id: 'focus', command: 'view.focusMode' },
    ],
  },
  organize: {
    icon: FolderTree,
    entries: [
      { id: 'courses', command: 'course.new' },
      { id: 'tags', command: 'view.toggleInspector' },
      { id: 'smart' },
      { id: 'templates', command: 'note.newFromTemplate' },
      { id: 'select', command: 'note.merge' },
      { id: 'versions' },
    ],
  },
  study: {
    icon: Layers,
    entries: [
      { id: 'flashcards', command: 'ai.flashcards' },
      { id: 'synthesis', command: 'ai.synthesize' },
      { id: 'visualize', command: 'ai.visualize' },
      { id: 'podcast', command: 'ai.podcast' },
      { id: 'define', command: 'ai.define' },
      { id: 'completion', command: 'edit.wordCompletion' },
    ],
  },
  tasks: {
    icon: CalendarCheck,
    entries: [
      { id: 'task', command: 'task.new' },
      { id: 'view', command: 'view.tasks' },
      { id: 'link' },
      { id: 'export', command: 'tasks.exportCalendar' },
      { id: 'import', command: 'tasks.importCalendar' },
    ],
  },
  ai: {
    icon: Sparkles,
    entries: [
      { id: 'provider', command: 'app.settings' },
      { id: 'ask', command: 'ai.ask' },
      { id: 'check', command: 'ai.rewrite' },
      { id: 'agent', command: 'ai.agent' },
      { id: 'mcp' },
    ],
  },
  files: {
    icon: FolderInput,
    entries: [
      { id: 'fromApp', command: 'note.importFromApp' },
      { id: 'document', command: 'note.importDocument' },
      { id: 'export', command: 'note.export' },
      { id: 'backup', command: 'backup.create' },
      { id: 'restore', command: 'backup.restore' },
    ],
  },
} satisfies Record<string, { icon: LucideIcon; entries: Entry[] }>;

type ArticleId = keyof typeof TOPICS;
type TopicId = ArticleId | 'shortcuts';
const ARTICLE_IDS = Object.keys(TOPICS) as ArticleId[];
const TOPIC_IDS: TopicId[] = [...ARTICLE_IDS, 'shortcuts'];

function topicIcon(id: TopicId): LucideIcon {
  return id === 'shortcuts' ? Keyboard : TOPICS[id].icon;
}

function entriesOf(topic: ArticleId): Entry[] {
  return TOPICS[topic].entries;
}

function Keys({ value }: { value: string }) {
  return <kbd className="hl-keys">{value}</kbd>;
}

export function HelpDialog() {
  const { t } = useTranslation();
  const open = useUiStore((state) => state.helpOpen);
  const setOpen = useUiStore((state) => state.setHelpOpen);
  const [topic, setTopic] = useState<TopicId>('start');
  const [query, setQuery] = useState('');
  const nav = useRef<HTMLDivElement>(null);
  const searching = query.trim().length > 0;

  useEffect(() => {
    if (!open) return;
    setTopic('start');
    setQuery('');
  }, [open]);

  function choose(id: TopicId) {
    setQuery('');
    setTopic(id);
  }

  function onNavKey(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next =
      TOPIC_IDS[(TOPIC_IDS.indexOf(topic) + step + TOPIC_IDS.length) % TOPIC_IDS.length]!;
    choose(next);
    nav.current?.querySelector<HTMLElement>(`[data-topic="${next}"]`)?.focus();
  }

  /** Close first: the command usually opens a dialog of its own. */
  function run(id: AppCommandId) {
    setOpen(false);
    void runAppCommand(id);
  }

  const Icon = topicIcon(topic);

  return (
    <ModalOverlay
      open={open}
      onClose={() => setOpen(false)}
      label={t('help.title')}
      placement="center"
      className="nb-help max-w-[860px]"
    >
      <div className="hl-body">
        <aside className="hl-side">
          <h2 className="hl-title">{t('help.title')}</h2>
          <label className="hl-search">
            <Search size={13} aria-hidden />
            <input
              type="search"
              data-autofocus
              placeholder={t('help.search')}
              aria-label={t('help.search')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div
            ref={nav}
            role="tablist"
            aria-label={t('help.topicsLabel')}
            aria-orientation="vertical"
            className="hl-nav"
            onKeyDown={onNavKey}
          >
            {TOPIC_IDS.map((id) => {
              const TabIcon = topicIcon(id);
              const selected = !searching && id === topic;
              return (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  id={`hl-tab-${id}`}
                  aria-selected={selected}
                  aria-controls="hl-panel"
                  tabIndex={id === topic ? 0 : -1}
                  data-topic={id}
                  className={cn('hl-tab', selected && 'is-selected')}
                  onClick={() => choose(id)}
                >
                  <TabIcon size={14} aria-hidden />
                  {t(`help.topics.${id}.title`)}
                </button>
              );
            })}
          </div>
        </aside>

        <div
          id="hl-panel"
          role="tabpanel"
          aria-labelledby={searching ? undefined : `hl-tab-${topic}`}
          aria-label={searching ? t('help.results', { query: query.trim() }) : undefined}
          className="hl-panel"
        >
          {searching ? (
            <SearchResults query={query.trim()} onRun={run} onOpen={choose} />
          ) : (
            // Keyed as one element, so a topic change replays the entrance
            // and never leaves the previous topic's heading behind.
            <article key={topic} className="hl-article">
              <header className="hl-header">
                <span className="hl-header-icon" aria-hidden>
                  <Icon size={17} />
                </span>
                <div>
                  <h3 className="hl-heading">{t(`help.topics.${topic}.title`)}</h3>
                  <p className="hl-lead">{t(`help.topics.${topic}.lead`)}</p>
                </div>
              </header>
              {topic === 'shortcuts' ? (
                <Shortcuts />
              ) : (
                <>
                  <ul className="hl-entries">
                    {entriesOf(topic).map((entry, index) => (
                      <EntryRow
                        key={entry.id}
                        topic={topic}
                        entry={entry}
                        index={index}
                        onRun={run}
                      />
                    ))}
                  </ul>
                  <aside className="hl-tip">
                    <Lightbulb size={14} aria-hidden />
                    <p>
                      <strong>{t('help.tipLabel')}</strong>
                      {t(`help.topics.${topic}.tip`)}
                    </p>
                  </aside>
                </>
              )}
            </article>
          )}
        </div>
      </div>

      <footer className="hl-footer">
        <GlassButton size="sm" variant="ghost" onClick={() => run('help.welcome')}>
          {t('help.tour')}
        </GlassButton>
        <GlassButton size="sm" variant="ghost" onClick={() => run('help.github')}>
          {t('help.github')}
          <ArrowUpRight size={12} aria-hidden />
        </GlassButton>
        <GlassButton size="sm" className="ml-auto" onClick={() => setOpen(false)}>
          {t('help.close')}
        </GlassButton>
      </footer>
    </ModalOverlay>
  );
}

function EntryRow({
  topic,
  entry,
  index,
  onRun,
  context,
}: {
  topic: ArticleId;
  entry: Entry;
  index: number;
  onRun(id: AppCommandId): void;
  /** The topic's name, shown on a search result. */
  context?: string;
}) {
  const { t } = useTranslation();
  const shortcut = entry.command
    ? commandShortcut(APP_COMMANDS[entry.command].accelerator)
    : entry.keys;
  const body = (
    <>
      {context && <span className="hl-entry-context">{context}</span>}
      <span className="hl-entry-title">
        {t(`help.topics.${topic}.entries.${entry.id}.title`)}
      </span>
      <span className="hl-entry-text">
        {t(`help.topics.${topic}.entries.${entry.id}.text`)}
      </span>
    </>
  );
  return (
    <li className="hl-entry" style={{ animationDelay: `${60 + index * 30}ms` }}>
      {/* An entry backed by a command is a way in, not only a description. */}
      {entry.command ? (
        <button
          type="button"
          className="hl-entry-main is-action"
          onClick={() => onRun(entry.command!)}
        >
          {body}
        </button>
      ) : (
        <span className="hl-entry-main">{body}</span>
      )}
      {shortcut && <Keys value={shortcut} />}
    </li>
  );
}

function SearchResults({
  query,
  onRun,
  onOpen,
}: {
  query: string;
  onRun(id: AppCommandId): void;
  onOpen(topic: TopicId): void;
}) {
  const { t } = useTranslation();
  const needle = query.toLocaleLowerCase();
  const hits = ARTICLE_IDS.flatMap((topic) =>
    entriesOf(topic)
      .filter((entry) =>
        [
          t(`help.topics.${topic}.entries.${entry.id}.title`),
          t(`help.topics.${topic}.entries.${entry.id}.text`),
        ]
          .join(' ')
          .toLocaleLowerCase()
          .includes(needle),
      )
      .map((entry) => ({ topic, entry })),
  );

  return (
    <div className="hl-article">
      <header className="hl-header">
        <span className="hl-header-icon" aria-hidden>
          <Search size={17} />
        </span>
        <div>
          <h3 className="hl-heading">{t('help.results', { query })}</h3>
        </div>
      </header>
      {hits.length === 0 ? (
        <p className="hl-empty">
          {t('help.noResults', { query })}{' '}
          <button type="button" className="hl-link" onClick={() => onOpen('shortcuts')}>
            {t('help.topics.shortcuts.title')}
          </button>
        </p>
      ) : (
        <ul className="hl-entries">
          {hits.map(({ topic, entry }, index) => (
            <EntryRow
              key={`${topic}.${entry.id}`}
              topic={topic}
              entry={entry}
              index={index}
              onRun={onRun}
              context={t(`help.topics.${topic}.title`)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

interface ShortcutGroup {
  label: string;
  rows: { id: string; label: string; keys: string }[];
}

/** Every menu item that has a shortcut, grouped by the menu it lives in. */
function shortcutGroups(menu: MenuNode[]): ShortcutGroup[] {
  const groups: ShortcutGroup[] = [];
  for (const node of menu) {
    if (node.kind !== 'submenu') continue;
    const rows = node.items.flatMap((item) => {
      if (item.kind !== 'item' || !item.enabled) return [];
      const keys = commandShortcut(item.accelerator);
      return keys ? [{ id: item.id, label: item.label, keys }] : [];
    });
    if (rows.length) groups.push({ label: node.label, rows });
  }
  return groups;
}

function Shortcuts() {
  const { t, i18n } = useTranslation();
  const [query, setQuery] = useState('');
  const groups = useMemo(
    () => shortcutGroups(buildMenuBar((key) => t(key))),
    // The labels follow the language.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [i18n.language],
  );
  const needle = query.trim().toLocaleLowerCase();
  const shown = groups
    .map((group) => ({
      ...group,
      rows: group.rows.filter((row) => row.label.toLocaleLowerCase().includes(needle)),
    }))
    .filter((group) => group.rows.length);

  return (
    <div className="hl-shortcuts">
      <label className="hl-search">
        <Search size={13} aria-hidden />
        <input
          type="search"
          placeholder={t('help.filter')}
          aria-label={t('help.filter')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      {shown.length === 0 ? (
        <p className="hl-empty">{t('help.noMatch', { query: query.trim() })}</p>
      ) : (
        <div className="hl-groups">
          {shown.map((group) => (
            <section key={group.label} className="hl-group">
              <h4 className="hl-group-label">{group.label}</h4>
              <ul>
                {group.rows.map((row) => (
                  <li key={row.id} className="hl-row">
                    <span>{row.label}</span>
                    <Keys value={row.keys} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
