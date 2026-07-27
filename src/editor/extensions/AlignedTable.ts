import { TableCell, TableHeader } from '@tiptap/extension-table';

function alignmentAttributes(
  parent: (() => Record<string, unknown>) | undefined,
) {
  return {
    ...(parent?.() ?? {}),
    textAlign: {
      default: 'left',
      parseHTML: (element: HTMLElement) =>
        element.style.textAlign || element.getAttribute('data-align') || 'left',
      renderHTML: (attributes: Record<string, unknown>) => ({
        'data-align': attributes.textAlign,
        style: `text-align: ${String(attributes.textAlign)}`,
      }),
    },
  };
}

export const AlignedTableCell = TableCell.extend({
  addAttributes() {
    return alignmentAttributes(this.parent);
  },
});

export const AlignedTableHeader = TableHeader.extend({
  addAttributes() {
    return alignmentAttributes(this.parent);
  },
});
