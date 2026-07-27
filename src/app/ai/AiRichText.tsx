import { CircleAlert, Info, TriangleAlert } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import { markdownToDoc } from '@/editor/markdown';
import type { DocNode } from '@/lib/schema';
import { cn } from '@/lib/utils/cn';

/**
 * A compact, read-only rendering of NotaBene Markdown for AI surfaces.
 *
 * Rendering the parsed document tree instead of injecting generated HTML keeps
 * model output inert while giving Ask answers and rewrite previews the same
 * hierarchy as the editor.
 */
export function AiRichText({
  markdown,
  className,
}: {
  markdown: string;
  className?: string;
}) {
  const doc = useMemo(() => markdownToDoc(markdown), [markdown]);

  return (
    <div
      className={cn(
        'min-w-0 break-words text-[13px] leading-[1.6] text-nb-text',
        className,
      )}
    >
      {doc.content.map((node, index) => renderBlock(node, `block-${index}`))}
    </div>
  );
}

function renderInline(node: DocNode, key: string): ReactNode {
  if (node.type === 'wikiLink') {
    return (
      <span key={key} className="font-medium text-[var(--nb-link)]">
        {String(node.attrs?.title ?? '')}
      </span>
    );
  }
  if (node.type === 'math') {
    return (
      <code
        key={key}
        className="rounded px-1 py-0.5 font-[var(--nb-font-mono)] text-[0.92em]"
      >
        {String(node.attrs?.latex ?? '')}
      </code>
    );
  }
  if (node.type !== 'text') {
    return (node.content ?? []).map((child, index) =>
      renderInline(child, `${key}-${index}`),
    );
  }

  let value: ReactNode = node.text ?? '';
  for (const [index, mark] of (node.marks ?? []).entries()) {
    const markKey = `${key}-mark-${index}`;
    switch (mark.type) {
      case 'bold':
        value = <strong key={markKey}>{value}</strong>;
        break;
      case 'italic':
        value = <em key={markKey}>{value}</em>;
        break;
      case 'strike':
        value = <s key={markKey}>{value}</s>;
        break;
      case 'underline':
        value = <u key={markKey}>{value}</u>;
        break;
      case 'highlight':
        value = <mark key={markKey}>{value}</mark>;
        break;
      case 'code':
        value = (
          <code
            key={markKey}
            className="rounded bg-[var(--nb-code-bg)] px-1 py-0.5 font-[var(--nb-font-mono)] text-[0.9em]"
          >
            {value}
          </code>
        );
        break;
      case 'link': {
        const href = safeLinkHref(mark.attrs?.href);
        value = href ? (
          <a
            key={markKey}
            href={href}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-[var(--nb-link)] underline decoration-current/35 underline-offset-2"
          >
            {value}
          </a>
        ) : (
          <span key={markKey}>{value}</span>
        );
        break;
      }
      default:
        break;
    }
  }
  return <span key={key}>{value}</span>;
}

function inlineChildren(node: DocNode, key: string): ReactNode[] {
  return (node.content ?? []).map((child, index) =>
    renderInline(child, `${key}-inline-${index}`),
  );
}

function blockChildren(node: DocNode, key: string): ReactNode[] {
  return (node.content ?? []).map((child, index) =>
    renderBlock(child, `${key}-child-${index}`),
  );
}

function renderBlock(node: DocNode, key: string): ReactNode {
  switch (node.type) {
    case 'paragraph':
      return (
        <p key={key} className="my-2 first:mt-0 last:mb-0">
          {inlineChildren(node, key)}
        </p>
      );
    case 'heading': {
      const level = Number(node.attrs?.level ?? 1);
      const content = inlineChildren(node, key);
      if (level <= 1) {
        return (
          <h3 key={key} className="mb-2 mt-4 text-[16px] font-semibold leading-tight">
            {content}
          </h3>
        );
      }
      if (level === 2) {
        return (
          <h4 key={key} className="mb-1.5 mt-4 text-[14px] font-semibold leading-tight">
            {content}
          </h4>
        );
      }
      return (
        <h5
          key={key}
          className="mb-1 mt-3 text-[12px] font-semibold uppercase tracking-[0.04em] text-nb-text-2"
        >
          {content}
        </h5>
      );
    }
    case 'horizontalRule':
      return (
        <hr key={key} className="my-3 border-0 border-t border-[var(--nb-divider)]" />
      );
    case 'blockquote':
      return (
        <blockquote
          key={key}
          className="my-3 border-l-2 border-[var(--nb-divider-strong)] pl-3 text-nb-text-2"
        >
          {blockChildren(node, key)}
        </blockquote>
      );
    case 'callout':
      return <CalloutBlock key={key} node={node} nodeKey={key} />;
    case 'toggle':
      return (
        <details
          key={key}
          className="my-3 rounded-nb-xs border border-[var(--nb-divider)] px-3 py-2"
        >
          <summary className="cursor-pointer font-medium">
            {String(node.attrs?.summary ?? 'Details')}
          </summary>
          <div className="mt-2">{blockChildren(node, key)}</div>
        </details>
      );
    case 'codeBlock':
      return (
        <pre
          key={key}
          className="my-3 overflow-x-auto rounded-nb-xs bg-[var(--nb-code-bg)] p-2.5 font-[var(--nb-font-mono)] text-[11px] leading-relaxed"
        >
          <code>{(node.content ?? []).map((child) => child.text ?? '').join('')}</code>
        </pre>
      );
    case 'mathBlock':
      return (
        <div
          key={key}
          className="my-3 overflow-x-auto rounded-nb-xs bg-[var(--nb-code-bg)] p-2 text-center font-[var(--nb-font-mono)] text-[12px]"
        >
          {String(node.attrs?.latex ?? '')}
        </div>
      );
    case 'bulletList':
      return (
        <ul key={key} className="my-2 list-disc space-y-1 pl-5">
          {(node.content ?? []).map((item, index) => (
            <li key={`${key}-${index}`}>{blockChildren(item, `${key}-${index}`)}</li>
          ))}
        </ul>
      );
    case 'orderedList':
      return (
        <ol
          key={key}
          start={Number(node.attrs?.start ?? 1)}
          className="my-2 list-decimal space-y-1 pl-5"
        >
          {(node.content ?? []).map((item, index) => (
            <li key={`${key}-${index}`}>{blockChildren(item, `${key}-${index}`)}</li>
          ))}
        </ol>
      );
    case 'taskList':
      return (
        <ul key={key} className="my-2 space-y-1.5">
          {(node.content ?? []).map((item, index) => (
            <li key={`${key}-${index}`} className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={item.attrs?.checked === true}
                readOnly
                tabIndex={-1}
                className="mt-1"
              />
              <div className="min-w-0 flex-1">
                {blockChildren(item, `${key}-${index}`)}
              </div>
            </li>
          ))}
        </ul>
      );
    case 'table':
      return (
        <div key={key} className="my-3 overflow-x-auto">
          <table className="w-full border-collapse text-left text-[12px]">
            <tbody>
              {(node.content ?? []).map((row, rowIndex) => (
                <tr key={`${key}-row-${rowIndex}`}>
                  {(row.content ?? []).map((cell, cellIndex) => {
                    const Cell = cell.type === 'tableHeader' ? 'th' : 'td';
                    return (
                      <Cell
                        key={`${key}-cell-${cellIndex}`}
                        className="border border-[var(--nb-divider)] px-2 py-1.5 align-top"
                      >
                        {blockChildren(cell, `${key}-cell-${cellIndex}`)}
                      </Cell>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'image':
      return (
        <p key={key} className="my-2 text-[12px] italic text-nb-text-3">
          {String(node.attrs?.caption ?? node.attrs?.alt ?? '')}
        </p>
      );
    case 'drawing':
    case 'mindMap':
      return (
        <p key={key} className="my-2 text-[12px] italic text-nb-text-3">
          {String(node.attrs?.title ?? '')}
        </p>
      );
    case 'listItem':
    case 'taskItem':
    case 'tableCell':
    case 'tableHeader':
      return <div key={key}>{blockChildren(node, key)}</div>;
    default:
      return <div key={key}>{blockChildren(node, key)}</div>;
  }
}

function CalloutBlock({ node, nodeKey }: { node: DocNode; nodeKey: string }) {
  const kind = String(node.attrs?.kind ?? 'info').toLowerCase();
  const tone =
    kind === 'warn'
      ? {
          icon: TriangleAlert,
          className:
            'border-[color-mix(in_srgb,var(--nb-warn)_35%,var(--nb-divider))] bg-[color-mix(in_srgb,var(--nb-warn)_7%,transparent)] text-[var(--nb-warn)]',
        }
      : kind === 'important'
        ? {
            icon: CircleAlert,
            className:
              'border-[color-mix(in_srgb,var(--nb-important)_35%,var(--nb-divider))] bg-[color-mix(in_srgb,var(--nb-important)_7%,transparent)] text-[var(--nb-important)]',
          }
        : {
            icon: Info,
            className:
              'border-[color-mix(in_srgb,var(--nb-callout-info)_35%,var(--nb-divider))] bg-[color-mix(in_srgb,var(--nb-callout-info)_7%,transparent)] text-[var(--nb-callout-info)]',
          };
  const Icon = tone.icon;

  return (
    <aside className={cn('my-3 rounded-nb-xs border px-3 py-2.5', tone.className)}>
      <div className="flex items-start gap-2">
        <Icon size={14} aria-hidden className="mt-[3px] shrink-0" />
        <div className="min-w-0 flex-1 text-nb-text">{blockChildren(node, nodeKey)}</div>
      </div>
    </aside>
  );
}

function safeLinkHref(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? value : undefined;
  } catch {
    return undefined;
  }
}
