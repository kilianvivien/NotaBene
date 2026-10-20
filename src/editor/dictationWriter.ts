import type { Editor } from '@tiptap/core';
import { Fragment } from '@tiptap/pm/model';
import { closeHistory } from '@tiptap/pm/history';
import type { Transaction } from '@tiptap/pm/state';
import type { DictationWriter } from './commandBridge';

/** A moving insertion point, independent of where the student subsequently clicks. */
export function createDictationWriter(
  editor: Editor,
  noteId: string,
): DictationWriter | null {
  if (!editor.isEditable || !editor.state.selection.$to.parent.isTextblock) return null;
  let position = editor.state.selection.to;
  let closed = false;
  let first = true;
  const map = ({ transaction }: { transaction: Transaction }) => {
    const mapped = transaction.mapping.mapResult(position, 1);
    position = mapped.pos;
    if (mapped.deletedAcross) closed = true;
  };
  editor.on('transaction', map);
  return {
    noteId,
    append(text) {
      if (closed || editor.isDestroyed || !editor.isEditable) return false;
      if (!text) return true;
      const schema = editor.schema;
      const nodes = text
        .split(/\r\n|\r|\n/)
        .flatMap((line, index) => [
          ...(index ? [schema.nodes.hardBreak!.create()] : []),
          ...(line ? [schema.text(line)] : []),
        ]);
      let transaction = editor.state.tr;
      if (first) transaction = closeHistory(transaction);
      first = false;
      editor.view.dispatch(
        transaction.replaceWith(position, position, Fragment.fromArray(nodes)),
      );
      return true;
    },
    close() {
      closed = true;
      editor.off('transaction', map);
      if (!editor.isDestroyed) editor.view.dispatch(closeHistory(editor.state.tr));
    },
  };
}
