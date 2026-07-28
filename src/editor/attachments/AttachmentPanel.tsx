import { Eye, File, FileText, Image, Paperclip, Plus, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { assets, dialog, library } from '@/lib/adapters';
import { ATTACHMENT_ACCEPT } from '@/lib/attachments/previewSupport';
import { addAttachmentCommand, deleteAttachmentCommand } from '@/lib/commands';
import type { Attachment } from '@/lib/schema';
import { useAttachmentStore } from '@/lib/state/attachmentStore';
import { AttachmentViewer } from './AttachmentViewer';

function AttachmentIcon({ mime }: { mime: string | null }) {
  if (mime?.startsWith('image/')) return <Image size={15} />;
  if (mime === 'application/pdf') return <FileText size={15} />;
  return <File size={15} />;
}

export function AttachmentPanel({ noteId }: { noteId: string }) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const revision = useAttachmentStore((state) => state.revision);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [mimes, setMimes] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<{
    attachment: Attachment;
    blob: Blob;
    url: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [addError, setAddError] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function refresh() {
    const rows = await library.listAttachments(noteId);
    setAttachments(rows);
    const pairs = await Promise.all(
      rows.map(async (attachment) => [
        attachment.assetId,
        (await assets.stat(attachment.assetId))?.mime ?? 'application/octet-stream',
      ]),
    );
    setMimes(Object.fromEntries(pairs));
  }

  useEffect(() => {
    setPreview(null);
    void refresh();
    // Podcast generation can add an attachment while this already-mounted
    // panel sits behind its dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId, revision]);

  useEffect(
    () => () => {
      if (preview?.url.startsWith('blob:')) URL.revokeObjectURL(preview.url);
    },
    [preview],
  );

  async function add(files: File[]) {
    setBusy(true);
    setAddError('');
    for (const file of files) {
      const result = await addAttachmentCommand(noteId, file);
      if (!result.ok) setAddError(t('editor.unsupportedAttachment'));
    }
    await refresh();
    setBusy(false);
  }

  async function remove(attachment: Attachment) {
    const confirmed = await dialog.confirm(
      t('editor.deleteAttachmentConfirm', { name: attachment.name }),
      {
        title: t('editor.deleteAttachmentTitle'),
        danger: true,
      },
    );
    if (!confirmed) return;
    setDeletingId(attachment.id);
    await deleteAttachmentCommand(attachment.id);
    if (preview?.attachment.id === attachment.id) closePreview();
    await refresh();
    setDeletingId(null);
  }

  async function openPreview(attachment: Attachment) {
    const blob = await assets.get(attachment.assetId);
    if (!blob) return;
    setPreview({ attachment, blob, url: URL.createObjectURL(blob) });
  }

  function closePreview() {
    setPreview(null);
  }

  return (
    <div className="nb-attachments">
      <input
        ref={input}
        hidden
        type="file"
        multiple
        accept={ATTACHMENT_ACCEPT}
        onChange={(event) => {
          void add([...(event.target.files ?? [])]);
          event.target.value = '';
        }}
      />
      <button
        type="button"
        className="nb-attachment-add"
        disabled={busy}
        onClick={() => input.current?.click()}
      >
        <Plus size={14} />
        {busy ? t('editor.addingAttachment') : t('editor.addAttachment')}
      </button>
      {addError && (
        <p className="nb-attachment-add-error" role="alert">
          {addError}
        </p>
      )}

      {attachments.length === 0 ? (
        <div className="nb-attachment-empty">
          <Paperclip size={18} />
          <p>{t('editor.noAttachments')}</p>
        </div>
      ) : (
        <ul>
          {attachments.map((attachment) => (
            <li key={attachment.id}>
              <span className="nb-file-icon">
                <AttachmentIcon mime={mimes[attachment.assetId] ?? null} />
              </span>
              <span title={attachment.name}>{attachment.name}</span>
              <button
                type="button"
                aria-label={t('editor.previewAttachment')}
                title={t('editor.previewAttachment')}
                onClick={() => void openPreview(attachment)}
              >
                <Eye size={13} />
              </button>
              <button
                type="button"
                aria-label={t('common.delete')}
                title={t('common.delete')}
                disabled={deletingId === attachment.id}
                onClick={() => void remove(attachment)}
              >
                <Trash2 size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {preview && (
        <AttachmentViewer
          attachment={preview.attachment}
          blob={preview.blob}
          mime={mimes[preview.attachment.assetId] ?? 'application/octet-stream'}
          url={preview.url}
          onClose={closePreview}
        />
      )}
    </div>
  );
}
