import type { Editor } from '@tiptap/core';
import { Fragment, Slice, type Node as PmNode } from '@tiptap/pm/model';
import { AllSelection, TextSelection } from '@tiptap/pm/state';
import { closeHistory } from '@tiptap/pm/history';

export interface SelectionTarget {
  from: number;
  to: number;
  text: string;
  doc: PmNode;
}

export function selectionTarget(editor: Editor): SelectionTarget | null {
  const { selection, doc } = editor.state;
  if (
    !(selection instanceof TextSelection || selection instanceof AllSelection) ||
    selection.empty
  )
    return null;
  let prose = true;
  doc.nodesBetween(selection.from, selection.to, (node) => {
    if (node.isAtom && !node.isText && node.type.name !== 'hardBreak') prose = false;
    if (['table', 'codeBlock'].includes(node.type.name)) prose = false;
  });
  const text = doc.textBetween(selection.from, selection.to, '\n\n', '\n');
  return prose && text.trim() && text.length <= 4_000
    ? { from: selection.from, to: selection.to, text, doc }
    : null;
}

/** Plain text never passes through the HTML parser, even if it contains tags. */
export function textSlice(editor: Editor, text: string): Slice {
  const blocks = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) =>
      editor.schema.nodes.paragraph!.create(null, line ? editor.schema.text(line) : null),
    );
  return new Slice(Fragment.from(blocks), 1, 1);
}

export function applySelectionText(
  editor: Editor,
  target: SelectionTarget,
  text: string,
): boolean {
  if (editor.isDestroyed || !editor.isEditable || !editor.state.doc.eq(target.doc))
    return false;
  const leading = target.text.match(/^\s*/)?.[0] ?? '';
  const trailing = target.text.match(/\s*$/)?.[0] ?? '';
  // Models trim their answer. Keep separators the user selected with a word,
  // and interpret blank-line paragraph boundaries without adding empty blocks.
  const replacement = `${leading}${text.trim()}${trailing}`
    .replace(/\r\n?/g, '\n')
    .replace(/\n\n/g, '\n');
  const tr = closeHistory(editor.state.tr).replaceRange(
    target.from,
    target.to,
    textSlice(editor, replacement),
  );
  editor.view.dispatch(tr);
  // Keep a subsequent keystroke out of this undo step.
  editor.view.dispatch(closeHistory(editor.state.tr));
  editor.commands.focus();
  return true;
}
