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
import {
  attachLinkOnlyCommand,
  attachWebLinkCommand,
  canKeepLinkOnly,
} from '@/lib/commands';
import { webLinkFailureMessage } from './webLinkMessage';

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
  /** Set when the page could not be read but its address was kept. */
  const [keptLinkOnly, setKeptLinkOnly] = useState(false);

  useEffect(() => {
    if (!open) return;
    setUrl('');
    setError(null);
    setKeptLinkOnly(false);
    setBusy(false);
  }, [open]);

  async function save(): Promise<void> {
    if (!url.trim() || busy) return;
    setBusy(true);
    setError(null);
    const result = await attachWebLinkCommand({ noteId, url });
    if (!result.ok) {
      // The page would not come, but the address is still worth having: keep
      // it, and stay open long enough to say why the article is missing.
      const kept = canKeepLinkOnly(result.message)
        ? await attachLinkOnlyCommand({ noteId, url })
        : null;
      setBusy(false);
      setError(webLinkFailureMessage(result.message, t));
      setKeptLinkOnly(kept?.ok ?? false);
      return;
    }
    setBusy(false);
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
        keptLinkOnly ? (
          <GlassButton variant="accent" onClick={onClose}>
            {t('common.close')}
          </GlassButton>
        ) : (
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
        )
      }
    >
      <input
        data-autofocus
        type="url"
        value={url}
        readOnly={keptLinkOnly}
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
      {keptLinkOnly ? (
        <FieldNote tone="notice">
          {error} {t('editor.linkKeptOnly')}
        </FieldNote>
      ) : error ? (
        <FieldNote tone="danger">{error}</FieldNote>
      ) : (
        <FieldNote>{t('editor.linkImagesDropped')}</FieldNote>
      )}
    </Dialog>
  );
}
