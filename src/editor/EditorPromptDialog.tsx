import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import katex from 'katex';
import { Dialog, GlassButton } from '@/components/glass';
import type { EditorPromptRequest } from './editorPrompt';

/** The footer sits outside the `<form>`, so the confirm button reaches it by
 * id — the same arrangement the organization dialogs use. */
const PROMPT_FORM = 'nb-editor-prompt-form';

const field =
  'w-full rounded-nb-sm border border-[var(--nb-control-border)] bg-[var(--nb-control-surface)] px-2 py-1.5 text-[13px] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--nb-accent-ring)]';

interface EditorPromptDialogProps {
  request: EditorPromptRequest | null;
  onResolve(value: string | null): void;
}

export function EditorPromptDialog({ request, onResolve }: EditorPromptDialogProps) {
  const { t } = useTranslation();
  const [value, setValue] = useState('');
  // The preview node is held in state rather than a ref so that it is a
  // dependency: the overlay mounts its children a commit after it opens, and a
  // ref would still be null when the effect first runs — which left the
  // preview blank until the first keystroke.
  const [preview, setPreview] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    if (request) setValue(request.value);
  }, [request]);

  useEffect(() => {
    if (!preview) return;
    try {
      katex.render(value, preview, {
        displayMode: true,
        throwOnError: false,
        strict: false,
      });
    } catch {
      preview.textContent = value;
    }
  }, [preview, value]);

  function submit(event: FormEvent) {
    event.preventDefault();
    onResolve(value);
  }

  // Stable, because `ModalOverlay` rebuilds its focus trap whenever `onClose`
  // changes identity and this dialog re-renders on every keystroke.
  const cancel = useCallback(() => onResolve(null), [onResolve]);

  /**
   * A callback ref, not an effect: the overlay mounts its panel one commit
   * after `open` flips, so an effect keyed on the request runs while the field
   * does not exist yet. Getting this wrong is not cosmetic — the caret stays in
   * the note and the equation is typed into the prose.
   */
  const focusField = useCallback(
    (node: HTMLInputElement | HTMLTextAreaElement | null) => {
      if (!node) return;
      node.focus();
      node.select();
    },
    [],
  );

  return (
    <Dialog
      open={request !== null}
      onClose={cancel}
      title={request?.title ?? ''}
      size="md"
      footer={
        <>
          <GlassButton size="sm" onClick={cancel}>
            {t('common.cancel')}
          </GlassButton>
          <GlassButton form={PROMPT_FORM} type="submit" size="sm" variant="accent">
            {t('common.confirm')}
          </GlassButton>
        </>
      }
    >
      <form id={PROMPT_FORM} onSubmit={submit}>
        {request?.math ? (
          <textarea
            ref={focusField}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            // A newline is only ever wanted inside a multi-line environment,
            // so plain Return confirms — what the prompt it replaces did.
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.shiftKey) return;
              event.preventDefault();
              onResolve(value);
            }}
            rows={3}
            spellCheck={false}
            placeholder="\frac{a}{b}"
            aria-label={request.title}
            className={`${field} font-mono`}
          />
        ) : (
          <input
            ref={focusField}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={request?.placeholder}
            aria-label={request?.title}
            className={field}
          />
        )}
      </form>

      {request?.math && (
        <div className="nb-math-preview" ref={setPreview} aria-hidden />
      )}
    </Dialog>
  );
}
