/**
 * Save a web page onto a note.
 *
 * The hint under the field is not filler. This is the one place NotaBene
 * reaches a host nobody configured, and an app that sells "no account, no
 * cloud, no telemetry" owes the student a plain sentence about what is about
 * to leave the machine — before it leaves, not in a settings page.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, FieldNote, GlassButton } from '@/components/glass';
import { attachWebLinkCommand } from '@/lib/commands';

/** Turn a `code:message` failure into something a student can act on. */
function messageFor(raw: string, t: (key: string) => string): string {
  const code = raw.split(':', 1)[0] ?? '';
  if (code === 'refused_host' || code === 'refused_scheme') return t('editor.linkRefusedHost');
  if (code === 'not_html') return t('editor.linkNotHtml');
  if (code === 'too_large') return t('editor.linkTooLarge');
  if (code === 'empty_page') return t('editor.linkEmpty');
  // The browser build cannot fetch at all, and "could not save" would send
  // someone hunting for a fault that is not there.
  if (code === 'unsupported') return t('editor.linkNeedsDesktop');
  return t('editor.linkFailed');
}

export function AddWebLinkDialog({
  open,
  noteId,
  onClose,
}: {
  open: boolean;
  noteId: string;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setUrl('');
    setError(null);
    setBusy(false);
  }, [open]);

  async function save(): Promise<void> {
    if (!url.trim() || busy) return;
    setBusy(true);
    setError(null);
    const result = await attachWebLinkCommand({ noteId, url });
    setBusy(false);
    if (!result.ok) {
      setError(messageFor(result.message, t));
      return;
    }
    // No callback: `attachWebLinkCommand` already announced the change, and
    // every attachment list is subscribed to that.
    onClose();
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('editor.addLinkTitle')}
      description={t('editor.addLinkHint')}
      size="sm"
      footer={
        <>
          <GlassButton variant="ghost" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </GlassButton>
          <GlassButton
            variant="accent"
            disabled={!url.trim() || busy}
            onClick={() => void save()}
          >
            {busy ? t('editor.savingLink') : t('common.save')}
          </GlassButton>
        </>
      }
    >
      <input
        data-autofocus
        type="url"
        value={url}
        onChange={(event) => setUrl(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void save();
          }
        }}
        placeholder={t('editor.addLinkPlaceholder')}
        aria-label={t('editor.addLinkTitle')}
        className="w-full rounded-nb-sm border border-[var(--nb-control-border)] bg-[var(--nb-control-surface)] px-2.5 py-2 text-[13px] text-nb-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--nb-accent-ring)]"
      />
      {error ? (
        <FieldNote tone="danger">{error}</FieldNote>
      ) : (
        <FieldNote>{t('editor.linkImagesDropped')}</FieldNote>
      )}
    </Dialog>
  );
}
