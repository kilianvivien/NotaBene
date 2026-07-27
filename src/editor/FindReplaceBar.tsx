import type { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { ChevronDown, ChevronUp, Replace, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface Match {
  from: number;
  to: number;
}

function findMatches(editor: Editor, query: string): Match[] {
  if (!query) return [];
  const needle = query.toLocaleLowerCase();
  const matches: Match[] = [];
  editor.state.doc.descendants((node, position) => {
    if (!node.isText || !node.text) return;
    const text = node.text.toLocaleLowerCase();
    let offset = 0;
    while ((offset = text.indexOf(needle, offset)) >= 0) {
      matches.push({ from: position + offset, to: position + offset + query.length });
      offset += Math.max(query.length, 1);
    }
  });
  return matches;
}

export function FindReplaceBar({
  editor,
  open,
  onClose,
}: {
  editor: Editor;
  open: boolean;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [active, setActive] = useState(0);
  // RichTextEditor re-renders on every transaction, so replacements refresh
  // this inexpensive scan immediately.
  const matches = findMatches(editor, query);

  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  useEffect(() => {
    if (active >= matches.length) setActive(Math.max(matches.length - 1, 0));
  }, [active, matches.length]);

  function select(index: number) {
    const match = matches[index];
    if (!match) return;
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, match.from, match.to),
      ),
    );
    editor.commands.focus();
  }

  function move(delta: number) {
    if (!matches.length) return;
    const next = (active + delta + matches.length) % matches.length;
    setActive(next);
    select(next);
  }

  function replaceOne() {
    const match = matches[active];
    if (!match) return;
    editor.view.dispatch(editor.state.tr.insertText(replacement, match.from, match.to));
  }

  function replaceAll() {
    let transaction = editor.state.tr;
    for (const match of [...matches].reverse()) {
      transaction = transaction.insertText(replacement, match.from, match.to);
    }
    if (transaction.docChanged) editor.view.dispatch(transaction);
  }

  if (!open) return null;
  return (
    <div className="nb-find-replace" role="search" aria-label={t('editor.findReplace')}>
      <input
        ref={inputRef}
        value={query}
        placeholder={t('editor.find')}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            move(event.shiftKey ? -1 : 1);
          } else if (event.key === 'Escape') onClose();
        }}
      />
      <span className="nb-find-count">
        {matches.length ? `${active + 1}/${matches.length}` : `0/0`}
      </span>
      <button
        type="button"
        aria-label={t('editor.previousMatch')}
        onClick={() => move(-1)}
      >
        <ChevronUp size={13} />
      </button>
      <button type="button" aria-label={t('editor.nextMatch')} onClick={() => move(1)}>
        <ChevronDown size={13} />
      </button>
      <input
        value={replacement}
        placeholder={t('editor.replaceWith')}
        onChange={(event) => setReplacement(event.target.value)}
      />
      <button type="button" aria-label={t('editor.replace')} onClick={replaceOne}>
        <Replace size={13} />
      </button>
      <button type="button" className="nb-replace-all" onClick={replaceAll}>
        {t('editor.replaceAll')}
      </button>
      <button type="button" aria-label={t('common.close')} onClick={onClose}>
        <X size={13} />
      </button>
    </div>
  );
}
