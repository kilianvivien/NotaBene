import { Node, mergeAttributes } from '@tiptap/core';
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from '@tiptap/react';
import { CheckCircle2, Circle, CircleDashed } from 'lucide-react';
import { useLibraryStore } from '@/lib/state/libraryStore';
import { useUiStore } from '@/lib/state/uiStore';
import { cn } from '@/lib/utils/cn';

/**
 * The chip as it appears while writing.
 *
 * Everything shown here is read from the store rather than from the node, so
 * ticking a task off in the Tasks view restyles every paragraph that mentions
 * it. The node's stored `label` is only the fallback for a task that has since
 * been purged — and for the exporters, which have no store to read.
 */
function TaskRefView({ node }: NodeViewProps) {
  const taskId = String(node.attrs.taskId ?? '');
  const fallback = String(node.attrs.label ?? '');
  const task = useLibraryStore((state) => state.tasks.find((entry) => entry.id === taskId));
  const openTasksView = useUiStore((state) => state.openTasksView);

  const done = task?.status === 'done';
  const missing = !task;
  const Icon = missing ? CircleDashed : done ? CheckCircle2 : Circle;

  return (
    <NodeViewWrapper as="span" className="inline">
      <span
        role="link"
        tabIndex={0}
        title={task?.title ?? fallback}
        onClick={() => taskId && openTasksView({ taskId })}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            if (taskId) openTasksView({ taskId });
          }
        }}
        className={cn(
          'mx-[1px] inline-flex cursor-pointer select-none items-center gap-1',
          'rounded-nb-xs px-1.5 py-[1px] align-baseline text-[0.9em]',
          'bg-[var(--nb-inset-surface)] ring-1 ring-inset ring-[var(--nb-control-border)]',
          'hover:bg-[var(--nb-hover)]',
          done && 'text-nb-text-3 line-through',
          // A chip whose task no longer exists says so rather than lying about
          // a to-do that is not there.
          missing && 'text-nb-text-3 opacity-70',
        )}
      >
        <Icon
          size={12}
          aria-hidden
          className={cn('shrink-0', done && 'text-[var(--nb-success)]')}
        />
        {task?.title ?? fallback}
      </span>
    </NodeViewWrapper>
  );
}

/**
 * An inline reference to a task.
 *
 * The node stores the id and a label; the NodeView above ignores the label and
 * reads the task from the store, so ticking one off restyles every paragraph
 * that mentions it and a rename shows through everywhere at once.
 *
 * The exporters are the exception: they have no store to read, so they render
 * the title captured at export time. That mirrors how `drawing` and `mindMap`
 * already behave.
 *
 * `DocNodeSchema` is structural rather than a fixed node vocabulary, so this
 * needs no change to the contract — which is what makes the chip cheap.
 */
export const TaskRef = Node.create({
  name: 'taskRef',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      taskId: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-task-id'),
      },
      /**
       * The title as it stood when the chip was inserted.
       *
       * Not the source of truth — the store is — but it is what survives a copy
       * into another app, an export, and a note read by an agent that has no
       * way to resolve the id.
       */
      label: {
        default: '',
        parseHTML: (element) =>
          element.getAttribute('data-label') ?? element.textContent ?? '',
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-task-ref]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-task-ref': '',
        'data-task-id': HTMLAttributes.taskId,
        'data-label': HTMLAttributes.label,
      }),
      `☐ ${String(HTMLAttributes.label ?? '')}`,
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(TaskRefView);
  },
});
