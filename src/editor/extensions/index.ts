import type { Extensions } from '@tiptap/core';
import type { Abbreviation as AbbreviationRule } from '@/lib/adapters';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Typography from '@tiptap/extension-typography';
import Link from '@tiptap/extension-link';
import Underline from '@tiptap/extension-underline';
import Highlight from '@tiptap/extension-highlight';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { Table, TableRow } from '@tiptap/extension-table';
import { Callout } from './Callout';
import { Toggle } from './Toggle';
import { MathBlock, MathInline } from './Math';
import { WikiLink } from './WikiLink';
import { Drawing } from './Drawing';
import { MindMap } from './MindMap';
import { AssetImage } from './AssetImage';
import { AlignedTableCell, AlignedTableHeader } from './AlignedTable';
import { Abbreviation } from './Abbreviation';
import { Concentration, type ConcentrationState } from './Concentration';

const CONCENTRATION_OFF: ConcentrationState = {
  active: false,
  lineFocus: 'off',
  blockCaret: false,
  typewriterScrolling: false,
};

/**
 * `resolveAbbreviations` and `resolveConcentration` are getters, not values:
 * the extensions array is memoised for the life of an editor, and both are
 * edited in Settings while a note is open.
 */
export function editorExtensions(
  placeholder: string,
  resolveAbbreviations: () => readonly AbbreviationRule[] = () => [],
  resolveConcentration: () => ConcentrationState = () => CONCENTRATION_OFF,
): Extensions {
  return [
    StarterKit.configure({
      link: false,
      underline: false,
    }),
    Placeholder.configure({ placeholder }),
    Typography,
    Link.configure({
      openOnClick: false,
      autolink: true,
      defaultProtocol: 'https',
    }),
    Underline,
    Highlight.configure({ multicolor: true }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Table.configure({ resizable: true }),
    TableRow,
    AlignedTableCell,
    AlignedTableHeader,
    Callout,
    Toggle,
    MathInline,
    MathBlock,
    WikiLink,
    AssetImage,
    Drawing,
    MindMap,
    Abbreviation.configure({ resolve: resolveAbbreviations }),
    Concentration.configure({ resolve: resolveConcentration }),
  ];
}
