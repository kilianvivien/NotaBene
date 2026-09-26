/**
 * Visualize this note: a mind map or a diagram, from one place.
 *
 * They were two dialogs of the same shape — generate, look, decide — and a
 * student choosing between them had to know in advance which one they wanted.
 * Here the first step shows both side by side, each with a small picture of
 * what it produces, because the difference is easiest to see:
 *
 * - A mind map is the note's concepts as a tree around one idea. It becomes a
 *   mind-map block, read full-window and edited as a tree.
 * - A diagram is what in the note causes, precedes or calls what. It becomes a
 *   drawing, edited afterwards in Excalidraw.
 *
 * The same lecture has both readings and they are rarely the same picture, so
 * both stay; each keeps its own preview and its own output. Nothing is written
 * until Insert, and a picture the model got wrong costs one more Generate.
 */
import {
  ArrowLeft,
  Loader2,
  Maximize2,
  Network,
  RefreshCw,
  Sparkles,
  Workflow,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MindMapViewer } from '@/app/mindmap/MindMapViewer';
import { ChoiceGroup, Dialog, FieldNote, GlassButton } from '@/components/glass';
import type { DiagramResult, MindMapResult } from '@/lib/ai';
import {
  insertDiagramCommand,
  insertMindMapCommand,
  proposeDiagramCommand,
  proposeMindMapCommand,
} from '@/lib/commands';
import { svgDataUri } from '@/lib/mindmap/svg';
import { beginRun, cancelRun, endRun, useAiStore } from '@/lib/state/aiStore';
import { useEditorStore } from '@/lib/state/editorStore';
import { useUiStore } from '@/lib/state/uiStore';
import { AiDialogStatus } from './AiDisclosure';
import { aiErrorMessage } from './aiErrorMessage';
import { useAiAvailability } from './useAiAvailability';

type Kind = 'mindMap' | 'diagram';

export function VisualizeDialog() {
  const { t } = useTranslation();
  const mindMapOpen = useUiStore((state) => state.aiMindMapOpen);
  const diagramOpen = useUiStore((state) => state.aiDiagramOpen);
  const setMindMapOpen = useUiStore((state) => state.setAiMindMapOpen);
  const setDiagramOpen = useUiStore((state) => state.setAiDiagramOpen);
  const noteId = useEditorStore((state) => state.note?.id ?? null);
  const running = useAiStore((state) => state.running);

  const open = mindMapOpen || diagramOpen;
  const [kind, setKind] = useState<Kind>('mindMap');
  const [mindMap, setMindMap] = useState<MindMapResult | null>(null);
  const [diagram, setDiagram] = useState<DiagramResult | null>(null);
  const [viewing, setViewing] = useState(false);
  const [error, setError] = useState('');

  const availability = useAiAvailability(kind, open);
  const busy = running === 'mindMap' || running === 'diagram';
  const result = kind === 'mindMap' ? mindMap : diagram;

  function reset(): void {
    setMindMap(null);
    setDiagram(null);
    setViewing(false);
    setError('');
  }

  // Each menu item opens on its own output; either way the other is a click
  // away. A picture of the note you were on is not a picture of this one.
  useEffect(() => {
    reset();
    if (mindMapOpen) setKind('mindMap');
    else if (diagramOpen) setKind('diagram');
  }, [noteId, mindMapOpen, diagramOpen]);

  function choose(next: Kind): void {
    setKind(next);
    setError('');
  }

  async function generate(): Promise<void> {
    if (!noteId) return;
    setError('');
    const signal = beginRun(kind);
    const outcome =
      kind === 'mindMap'
        ? await proposeMindMapCommand(noteId, { signal })
        : await proposeDiagramCommand(noteId, { signal });
    endRun(kind, signal);
    if (!outcome.ok) {
      // A cancel is not a failure: the student pressed the button and knows
      // what happened.
      if (outcome.code !== 'cancelled') setError(aiErrorMessage(outcome, t));
      return;
    }
    if (kind === 'mindMap') setMindMap(outcome.value as MindMapResult);
    else setDiagram(outcome.value as DiagramResult);
  }

  async function insert(): Promise<void> {
    if (!noteId) return;
    const outcome =
      kind === 'mindMap' && mindMap
        ? await insertMindMapCommand(noteId, mindMap)
        : kind === 'diagram' && diagram
          ? await insertDiagramCommand(noteId, diagram)
          : null;
    if (!outcome) return;
    if (!outcome.ok) {
      setError(outcome.message);
      return;
    }
    close();
  }

  /** One close for Escape, Cancel, and the status pill on its way to
   * Settings — a dialog left open behind that window is one you cannot reach. */
  function close(): void {
    cancelRun('mindMap');
    cancelRun('diagram');
    setMindMapOpen(false);
    setDiagramOpen(false);
    reset();
  }

  function back(): void {
    if (kind === 'mindMap') setMindMap(null);
    else setDiagram(null);
    setViewing(false);
    setError('');
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title={result ? t(`ai.${kind}`) : t('visualize.title')}
      description={result ? undefined : t('visualize.intro')}
      size="lg"
      headerAction={<AiDialogStatus feature={kind} onLeave={close} />}
      footer={
        result ? (
          <>
            <span className="mr-auto">
              <GlassButton size="sm" variant="ghost" onClick={back} disabled={busy}>
                <ArrowLeft size={12} aria-hidden />
                {t('check.back')}
              </GlassButton>
            </span>
            <GlassButton
              size="sm"
              variant="ghost"
              disabled={!availability.available || busy}
              onClick={() => void generate()}
            >
              {busy ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <RefreshCw size={12} aria-hidden />
              )}
              {busy ? t('ai.running') : t('ai.regenerate')}
            </GlassButton>
            <GlassButton
              size="sm"
              variant="accent"
              disabled={busy}
              onClick={() => void insert()}
            >
              {t('ai.insertIntoNote')}
            </GlassButton>
          </>
        ) : (
          <>
            <GlassButton size="sm" onClick={busy ? () => cancelRun(kind) : close}>
              {busy ? t('ai.cancel') : t('common.cancel')}
            </GlassButton>
            <GlassButton
              size="sm"
              variant="accent"
              disabled={!noteId || !availability.available || busy}
              onClick={() => void generate()}
            >
              {busy ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Sparkles size={12} aria-hidden />
              )}
              {busy
                ? t('ai.running')
                : t(
                    kind === 'mindMap'
                      ? 'visualize.makeMindMap'
                      : 'visualize.makeDiagram',
                  )}
            </GlassButton>
          </>
        )
      }
    >
      {!result ? (
        <KindPicker kind={kind} onChoose={choose} disabled={busy} />
      ) : kind === 'mindMap' && mindMap ? (
        <figure className="flex flex-col gap-2">
          {/* The preview is deliberately small and the real view is one click
              away: a map big enough to read does not fit in a dialog, and a
              dialog stretched until it does is a worse full-screen viewer. */}
          <button
            type="button"
            className="nb-mind-map-preview"
            onClick={() => setViewing(true)}
            aria-label={t('ai.mindMapZoom')}
          >
            <img
              src={svgDataUri(mindMap.svg)}
              alt={mindMap.map.title}
              draggable={false}
            />
            <span className="nb-mind-map-open">
              <Maximize2 size={13} aria-hidden />
              {t('ai.mindMapZoom')}
            </span>
          </button>
          <figcaption className="text-[12px] text-nb-text-3">
            {mindMap.map.title} ·{' '}
            {t('ai.mindMapNodes', { count: mindMap.map.nodes.length })}
          </figcaption>
          {viewing && (
            <MindMapViewer
              svg={mindMap.svg}
              title={mindMap.map.title}
              data={mindMap.map}
              onClose={() => setViewing(false)}
            />
          )}
        </figure>
      ) : (
        diagram && (
          // The rendered scene rather than the Mermaid, because the Mermaid is
          // scaffolding: a student who wants to change the diagram edits it as
          // a drawing after inserting it.
          <figure className="flex flex-col gap-2">
            <div className="nb-diagram-preview">
              <img
                src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(diagram.scene.svg)}`}
                alt={diagram.answer.title}
                draggable={false}
              />
            </div>
            <figcaption className="text-[12px] text-nb-text-3">
              {diagram.answer.title} · {t(`ai.diagramKind_${diagram.answer.kind}`)}
            </figcaption>
          </figure>
        )
      )}

      {busy && !result && (
        <p className="mt-3 flex items-center justify-center gap-2 text-[12px] text-nb-text-3">
          <Loader2 size={13} className="animate-spin" aria-hidden />
          {t(kind === 'mindMap' ? 'visualize.drawingMap' : 'visualize.drawingDiagram')}
        </p>
      )}
      {error && <FieldNote tone="danger">{error}</FieldNote>}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Choosing
// ---------------------------------------------------------------------------

function KindPicker({
  kind,
  onChoose,
  disabled,
}: {
  kind: Kind;
  onChoose(kind: Kind): void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  return (
    <ChoiceGroup<Kind>
      label={t('visualize.what')}
      value={kind}
      onChange={onChoose}
      disabled={disabled}
      columns={2}
      options={[
        { value: 'mindMap', icon: Network, picture: <MindMapPicture /> },
        { value: 'diagram', icon: Workflow, picture: <DiagramPicture /> },
      ].map((option) => ({
        ...option,
        value: option.value as Kind,
        title: t(`ai.${option.value}`),
        description: t(`visualize.${option.value}Hint`),
        detail: (
          <span className="mt-1.5 block text-[11px] leading-snug text-nb-text-3">
            {t(`visualize.${option.value}Output`)}
          </span>
        ),
      }))}
    />
  );
}

/** A tree around one idea — what a mind map will look like, in miniature.
 * Drawn in `currentColor` so the card's state colours it. */
function MindMapPicture() {
  const leaves: [number, number][] = [
    [30, 22],
    [150, 22],
    [18, 62],
    [162, 62],
    [42, 100],
    [138, 100],
  ];
  return (
    <svg width="180" height="118" viewBox="0 0 180 118" fill="none">
      {leaves.map(([x, y]) => (
        <path
          key={`${x}-${y}`}
          d={`M90 61 Q ${(90 + x) / 2} ${y} ${x} ${y}`}
          stroke="currentColor"
          strokeOpacity="0.45"
          strokeWidth="1.5"
        />
      ))}
      {leaves.map(([x, y]) => (
        <rect
          key={`r-${x}-${y}`}
          x={x - 13}
          y={y - 6}
          width="26"
          height="12"
          rx="4"
          fill="var(--nb-paper, #fff)"
          stroke="currentColor"
          strokeWidth="1.3"
        />
      ))}
      <rect x="66" y="50" width="48" height="22" rx="7" fill="currentColor" />
    </svg>
  );
}

/** Steps with arrows and a branch — a flowchart, in miniature. */
function DiagramPicture() {
  return (
    <svg width="190" height="100" viewBox="0 0 190 100" fill="none">
      <defs>
        <marker
          id="nb-visualize-arrow"
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="6"
          markerHeight="6"
          orient="auto"
        >
          <path d="M0 0 L8 4 L0 8 z" fill="currentColor" />
        </marker>
      </defs>
      <g stroke="currentColor" strokeWidth="1.4" markerEnd="url(#nb-visualize-arrow)">
        <path d="M46 50 H64" />
        <path d="M108 43 L126 26" />
        <path d="M108 57 L126 74" />
      </g>
      <rect x="8" y="38" width="38" height="24" rx="5" fill="currentColor" />
      <path
        d="M86 32 L108 50 L86 68 L64 50 Z"
        fill="var(--nb-paper, #fff)"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <rect
        x="128"
        y="14"
        width="52"
        height="22"
        rx="5"
        fill="var(--nb-paper, #fff)"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <rect
        x="128"
        y="64"
        width="52"
        height="22"
        rx="5"
        fill="var(--nb-paper, #fff)"
        stroke="currentColor"
        strokeWidth="1.4"
      />
    </svg>
  );
}
