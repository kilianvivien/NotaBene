import { ChevronDown, ChevronRight, GripVertical } from 'lucide-react';
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Dialog, GlassButton } from '@/components/glass';
import { reparentMindMap, visibleMindMap } from '@/lib/mindmap/edit';
import { mindMapToSvg } from '@/lib/mindmap/layout';
import type { MindMap } from '@/lib/schema';

export function MindMapEditor({
  open,
  map,
  collapsed: initialCollapsed,
  onClose,
  onSave,
}: {
  open: boolean;
  map: MindMap;
  collapsed: string[];
  onClose(): void;
  onSave(map: MindMap, collapsed: string[], svg: string): void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(map);
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [dragged, setDragged] = useState<string | null>(null);
  const children = new Set(draft.edges.map((edge) => edge.from));
  const targets = new Set(draft.edges.map((edge) => edge.to));
  const rootId = draft.nodes.find((node) => !targets.has(node.id))?.id;

  function reorder(beforeId: string) {
    if (!dragged || dragged === beforeId) return;
    const moving = draft.nodes.find((node) => node.id === dragged);
    if (!moving) return;
    const rest = draft.nodes.filter((node) => node.id !== dragged);
    const index = rest.findIndex((node) => node.id === beforeId);
    rest.splice(index < 0 ? rest.length : index, 0, moving);
    setDraft({ ...draft, nodes: rest });
    setDragged(null);
  }

  return createPortal(
    <Dialog
      open={open}
      onClose={onClose}
      title={t('mindMap.edit')}
      description={t('mindMap.editHint')}
      size="lg"
      footer={
        <>
          <GlassButton size="sm" onClick={onClose}>
            {t('common.cancel')}
          </GlassButton>
          <GlassButton
            size="sm"
            variant="accent"
            onClick={() => {
              const projection = visibleMindMap(draft, collapsed);
              onSave(draft, collapsed, mindMapToSvg(projection));
            }}
          >
            {t('common.save')}
          </GlassButton>
        </>
      }
    >
      <label className="flex flex-col gap-1 text-[12px] text-nb-text-2">
        {t('mindMap.title')}
        <input
          value={draft.title}
          onChange={(event) => setDraft({ ...draft, title: event.target.value })}
          className="h-8 rounded-nb-xs border border-[var(--nb-control-border)] bg-[var(--nb-control-surface)] px-2 text-nb-text"
        />
      </label>
      <ol className="mt-3 flex max-h-[48vh] flex-col gap-1 overflow-y-auto">
        {draft.nodes.map((node) => (
          <li
            key={node.id}
            draggable
            onDragStart={() => setDragged(node.id)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={() => reorder(node.id)}
            className="grid grid-cols-[24px_minmax(0,1fr)_150px] items-center gap-2 rounded-nb-xs border border-[var(--nb-divider)] p-1.5"
          >
            <button
              type="button"
              draggable={false}
              disabled={!children.has(node.id)}
              aria-label={
                collapsed.includes(node.id)
                  ? t('mindMap.expandBranch')
                  : t('mindMap.collapseBranch')
              }
              onClick={() =>
                setCollapsed((current) =>
                  current.includes(node.id)
                    ? current.filter((id) => id !== node.id)
                    : [...current, node.id],
                )
              }
              className="grid h-6 w-6 place-items-center text-nb-text-3"
            >
              {children.has(node.id) ? (
                collapsed.includes(node.id) ? (
                  <ChevronRight size={13} />
                ) : (
                  <ChevronDown size={13} />
                )
              ) : (
                <GripVertical size={13} />
              )}
            </button>
            <input
              value={node.label}
              aria-label={t('mindMap.nodeLabel')}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  nodes: draft.nodes.map((entry) =>
                    entry.id === node.id ? { ...entry, label: event.target.value } : entry,
                  ),
                })
              }
              className="h-7 min-w-0 rounded-nb-xs border border-[var(--nb-control-border)] bg-[var(--nb-control-surface)] px-2 text-[12px]"
            />
            <select
              value={draft.edges.find((edge) => edge.to === node.id)?.from ?? ''}
              disabled={node.id === rootId}
              aria-label={t('mindMap.parent')}
              onChange={(event) =>
                setDraft(reparentMindMap(draft, node.id, event.target.value))
              }
              className="h-7 rounded-nb-xs border border-[var(--nb-control-border)] bg-[var(--nb-control-surface)] px-1 text-[11px]"
            >
              {node.id === rootId && <option value="">{t('mindMap.root')}</option>}
              {draft.nodes
                .filter((candidate) => candidate.id !== node.id)
                .map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.label}
                  </option>
                ))}
            </select>
          </li>
        ))}
      </ol>
    </Dialog>,
    document.body,
  );
}
