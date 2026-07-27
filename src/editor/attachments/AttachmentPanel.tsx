import { Eye, File, FileText, Image, Paperclip, Plus, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { assets, library } from '@/lib/adapters';
import {
  addAttachmentCommand,
  deleteAttachmentCommand,
} from '@/lib/commands';
import type { Attachment } from '@/lib/schema';

function AttachmentIcon({ mime }: { mime: string | null }) {
  if (mime?.startsWith('image/')) return <Image size={15} />;
  if (mime === 'application/pdf') return <FileText size={15} />;
  return <File size={15} />;
}

export function AttachmentPanel({ noteId }: { noteId: string }) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [mimes, setMimes] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<{ attachment: Attachment; url: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);

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
    void refresh();
    return () => {
      if (preview?.url.startsWith('blob:')) URL.revokeObjectURL(preview.url);
    };
    // A note change closes an old note's preview.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId]);

  async function add(files: File[]) {
    setBusy(true);
    for (const file of files) await addAttachmentCommand(noteId, file);
    await refresh();
    setBusy(false);
  }

  async function remove(attachment: Attachment) {
    await deleteAttachmentCommand(attachment.id);
    if (preview?.attachment.id === attachment.id) closePreview();
    await refresh();
  }

  async function openPreview(attachment: Attachment) {
    const url = await assets.urlFor(attachment.assetId);
    if (!url) return;
    if (preview?.url.startsWith('blob:')) URL.revokeObjectURL(preview.url);
    setPreview({ attachment, url });
  }

  function closePreview() {
    if (preview?.url.startsWith('blob:')) URL.revokeObjectURL(preview.url);
    setPreview(null);
  }

  return (
    <div className="nb-attachments">
      <input
        ref={input}
        hidden
        type="file"
        multiple
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
                onClick={() => void remove(attachment)}
              >
                <Trash2 size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {preview && (
        <div className="nb-attachment-preview">
          <div>
            <strong>{preview.attachment.name}</strong>
            <button
              type="button"
              aria-label={t('common.close')}
              onClick={closePreview}
            >
              <X size={14} />
            </button>
          </div>
          {mimes[preview.attachment.assetId]?.startsWith('image/') ? (
            <img src={preview.url} alt={preview.attachment.name} />
          ) : (
            <iframe src={preview.url} title={preview.attachment.name} />
          )}
        </div>
      )}
    </div>
  );
}
