import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';
import i18n from '@/lib/i18n';
import { editorExtensions } from '.';

let editor: Editor | undefined;

afterEach(async () => {
  editor?.destroy();
  editor = undefined;
  await i18n.changeLanguage('en');
});

describe('toggle blocks', () => {
  it('persists the open state when its summary is clicked', () => {
    editor = new Editor({
      extensions: editorExtensions('Write…'),
      content: {
        type: 'doc',
        content: [
          {
            type: 'toggle',
            attrs: { summary: 'Answer', open: false },
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: 'Hidden response' }],
              },
            ],
          },
        ],
      },
    });

    const summary = editor.view.dom.querySelector('summary');
    expect(summary).not.toBeNull();
    summary?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(editor.getJSON().content?.[0]?.attrs?.open).toBe(true);
    expect(editor.view.dom.querySelector('details')?.hasAttribute('open')).toBe(true);
  });

  it('localises the legacy Answer marker in an existing French note', async () => {
    await i18n.changeLanguage('fr');
    editor = new Editor({
      extensions: editorExtensions('Écrire…'),
      content: {
        type: 'doc',
        content: [
          {
            type: 'toggle',
            attrs: { summary: 'Answer', open: false },
            content: [{ type: 'paragraph' }],
          },
        ],
      },
    });

    expect(editor.view.dom.querySelector('summary')?.textContent).toBe('Réponse');
  });
});
