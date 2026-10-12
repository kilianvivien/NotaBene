/**
 * What the graph knows about the note that was clicked.
 *
 * A dot and a name are enough to find a note, not to decide whether it is the
 * one worth opening. This card answers that without leaving the graph: where
 * the note lives, when it was last touched, how it begins, and every note on
 * the other end of one of its lines — each of which is a button, so the graph
 * can be walked link by link from here.
 *
 * Unlinked mentions are listed with the same *Link* action the inspector
 * offers. It is `linkMentionCommand` either way, so a link made here is the
 * same versioned edit.
 */
import {
  ArrowDownLeft,
  ArrowUpRight,
  CornerDownLeft,
  MessageCircleQuestion,
  Sparkles,
  Unlink,
  X,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { linkMentionCommand, readNoteCommand } from '@/lib/commands';
import type { DocNode, NoteDoc } from '@/lib/schema';
import { useLibraryAccessStore } from '@/lib/state/libraryAccessStore';

const EXCERPT_CHARS = 280;

export interface DetailNote {
  id: string;
  title: string;
  /** Course colour, or empty for a note in no course. */
  colour: string;
}

export interface GraphDetailProps {
  note: DetailNote;
  course: string | null;
  tags: string[];
  updatedAt: string;
  linksTo: DetailNote[];
  linkedFrom: DetailNote[];
  /** Notes this one names without linking to them. */
  mentions: DetailNote[];
  /** Notes that name this one without linking to it. */
  mentionedBy: DetailNote[];
  /** Whether mentions are on screen at all; the two lists are empty if not. */
  showMentions: boolean;
  onSelect(noteId: string): void;
  /** Light a note on the canvas while its row is hovered or focused. */
  onPreview(noteId: string | null): void;
  onOpen(): void;
  onClose(): void;
  /** A mention became a link: the graph must be read again. */
  onLinked(): void;
  /**
   * Hand this note and its linked notes to Synthesis, or to Ask. Each is
   * absent when no AI provider can serve it: the graph is complete without
   * AI, and a button that can only say "set up a provider" is not offered.
   */
  onSynthesize?(): void;
  onAsk?(): void;
}

interface Excerpt {
  text: string;
  words: number;
}

/**
 * The note as a reader would say it aloud.
 *
 * Not `plainText`: that is the search index's projection, and a wiki link
 * contributes nothing to it, so "Builds on [[Damping]]." comes out as "Builds
 * on ." — fine for an index, wrong for an excerpt in a view that is *about*
 * links.
 */
function readable(doc: NoteDoc): string {
  const out: string[] = [];
  const walk = (node: DocNode) => {
    if (node.text) out.push(node.text);
    if (node.type === 'wikiLink') {
      const { label, title } = node.attrs ?? {};
      out.push(String(label || title || ''));
    }
    node.content?.forEach(walk);
    // Any node with children is a block or a container; a space keeps the
    // last word of one from running into the first of the next.
    if (node.content) out.push(' ');
  };
  doc.content.forEach(walk);
  return out.join('').replace(/\s+/g, ' ').trim();
}

function Dot({ colour }: { colour: string }) {
  return (
    <span className="nb-graph-dot" style={{ background: colour || 'var(--nb-text-3)' }} />
  );
}

export function GraphDetail({
  note,
  course,
  tags,
  updatedAt,
  linksTo,
  linkedFrom,
  mentions,
  mentionedBy,
  showMentions,
  onSelect,
  onPreview,
  onOpen,
  onClose,
  onLinked,
  onSynthesize,
  onAsk,
}: GraphDetailProps) {
  const { t, i18n } = useTranslation();
  const readOnly = useLibraryAccessStore((state) => state.status?.readOnly === true);
  const [excerpt, setExcerpt] = useState<Excerpt | null>(null);
  const [linking, setLinking] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);

  useEffect(() => {
    let active = true;
    setExcerpt(null);
    setFailure(null);
    void readNoteCommand(note.id).then((result) => {
      if (!active || !result.ok) return;
      const text = readable(result.value.doc);
      setExcerpt({
        text:
          text.length > EXCERPT_CHARS
            ? `${text.slice(0, EXCERPT_CHARS).trimEnd()}…`
            : text,
        words: text ? text.split(' ').length : 0,
      });
    });
    return () => {
      active = false;
    };
  }, [note.id]);

  async function link(sourceId: string, targetId: string) {
    const key = `${sourceId}>${targetId}`;
    setLinking(key);
    setFailure(null);
    const result = await linkMentionCommand({ sourceId, targetId });
    setLinking(null);
    if (result.ok) {
      onLinked();
      return;
    }
    setFailure({
      key,
      message:
        result.code === 'not_supported'
          ? t('inspector.mentionNotLinkable')
          : result.code === 'conflict'
            ? t('inspector.mentionConflict')
            : result.message,
    });
  }

  const edited = new Date(updatedAt).toLocaleDateString(i18n.language, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

  function rows(
    notes: DetailNote[],
    /** For a mention row: the edit *Link* would make. */
    linkable?: (other: DetailNote) => { sourceId: string; targetId: string },
  ): ReactNode {
    return (
      <ul>
        {notes.map((other) => {
          const edit = linkable?.(other);
          const key = edit ? `${edit.sourceId}>${edit.targetId}` : other.id;
          return (
            <li key={other.id}>
              <div className="nb-graph-detail-row">
                <button
                  type="button"
                  className="nb-graph-detail-note"
                  onClick={() => onSelect(other.id)}
                  onMouseEnter={() => onPreview(other.id)}
                  onMouseLeave={() => onPreview(null)}
                  onFocus={() => onPreview(other.id)}
                  onBlur={() => onPreview(null)}
                >
                  <Dot colour={other.colour} />
                  <span>{other.title}</span>
                </button>
                {edit && !readOnly && (
                  <button
                    type="button"
                    className="nb-graph-detail-link"
                    disabled={linking !== null}
                    title={t('inspector.mentionLinkHint')}
                    onClick={() => void link(edit.sourceId, edit.targetId)}
                  >
                    {t('inspector.mentionLink')}
                  </button>
                )}
              </div>
              {failure?.key === key && (
                <p role="alert" className="nb-graph-detail-error">
                  {failure.message}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    );
  }

  const section = (icon: ReactNode, heading: string, count: number, body: ReactNode) =>
    count > 0 && (
      <section>
        <h4>
          {icon}
          {heading}
          <span>{count}</span>
        </h4>
        {body}
      </section>
    );

  const connected =
    linksTo.length + linkedFrom.length + mentions.length + mentionedBy.length > 0;

  return (
    <aside
      className="nb-graph-detail"
      aria-label={t('graph.detail.label', { title: note.title })}
      // The card sits on the stage; a drag that starts on it must not pan the
      // graph underneath, and a click must not clear the selection.
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <header>
        <p className="nb-graph-detail-course">
          <Dot colour={note.colour} />
          <span>{course ?? t('graph.noCourse')}</span>
        </p>
        <button
          type="button"
          className="nb-graph-detail-close"
          aria-label={t('graph.detail.close')}
          title={t('graph.detail.close')}
          onClick={onClose}
        >
          <X size={13} />
        </button>
      </header>

      <div className="nb-graph-detail-body">
        <h3>{note.title}</h3>
        <p className="nb-graph-detail-meta">
          {t('graph.detail.edited', { date: edited })}
          {excerpt && excerpt.words > 0 && (
            <> · {t('graph.detail.words', { count: excerpt.words })}</>
          )}
        </p>
        {tags.length > 0 && (
          <ul className="nb-graph-detail-tags" aria-label={t('graph.filterTag')}>
            {tags.map((tag) => (
              <li key={tag}>{tag}</li>
            ))}
          </ul>
        )}
        {/* Reserved while it loads, so the lists below do not jump. */}
        <p
          className="nb-graph-detail-excerpt"
          data-empty={excerpt?.text === '' || undefined}
        >
          {excerpt === null ? ' ' : excerpt.text || t('graph.detail.emptyNote')}
        </p>

        <button type="button" className="nb-graph-detail-open" onClick={onOpen}>
          {t('graph.detail.open')}
          <kbd>
            <CornerDownLeft size={11} aria-hidden />
          </kbd>
        </button>

        {/* Only for a note that has links: with none, these would be the
            single-note features under another name. */}
        {linksTo.length + linkedFrom.length > 0 && (onSynthesize || onAsk) && (
          <div className="nb-graph-detail-ai">
            <p>
              <Sparkles size={11} aria-hidden />
              {t('graph.detail.withLinked', {
                count: new Set([...linksTo, ...linkedFrom].map((other) => other.id)).size,
              })}
            </p>
            <div>
              {onSynthesize && (
                <button
                  type="button"
                  title={t('graph.detail.synthesizeHint')}
                  onClick={onSynthesize}
                >
                  {t('graph.detail.synthesize')}
                </button>
              )}
              {onAsk && (
                <button type="button" title={t('graph.detail.askHint')} onClick={onAsk}>
                  <MessageCircleQuestion size={12} aria-hidden />
                  {t('graph.detail.ask')}
                </button>
              )}
            </div>
          </div>
        )}

        {section(
          <ArrowUpRight size={12} aria-hidden />,
          t('graph.detail.linksTo'),
          linksTo.length,
          rows(linksTo),
        )}
        {section(
          <ArrowDownLeft size={12} aria-hidden />,
          t('graph.detail.linkedFrom'),
          linkedFrom.length,
          rows(linkedFrom),
        )}
        {section(
          <Unlink size={12} aria-hidden />,
          t('graph.detail.mentionedBy'),
          mentionedBy.length,
          rows(mentionedBy, (other) => ({ sourceId: other.id, targetId: note.id })),
        )}
        {section(
          <Unlink size={12} aria-hidden />,
          t('graph.detail.mentions'),
          mentions.length,
          rows(mentions, (other) => ({ sourceId: note.id, targetId: other.id })),
        )}
        {!connected && (
          <p className="nb-graph-detail-alone">
            {showMentions ? t('graph.detail.alone') : t('graph.detail.aloneTryMentions')}
          </p>
        )}
      </div>
    </aside>
  );
}
