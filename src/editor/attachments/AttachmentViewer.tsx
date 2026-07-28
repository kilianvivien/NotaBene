/**
 * Full-window attachment preview.
 *
 * Attachments used to render inside the inspector's narrow column. Like the
 * mind-map viewer, this portals to `document.body` so editor containment and
 * inspector overflow cannot crop the content.
 */
import { X } from 'lucide-react';
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

interface AttachmentViewerProps {
  name: string;
  mime: string;
  url: string;
  onClose(): void;
}

export function AttachmentViewer({ name, mime, url, onClose }: AttachmentViewerProps) {
  const { t } = useTranslation();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return createPortal(
    <div
      className="nb-attachment-viewer"
      role="dialog"
      aria-modal="true"
      aria-label={name}
    >
      <header className="nb-map-viewer-bar">
        <h2 className="nb-map-viewer-title">{name}</h2>
        <span className="nb-attachment-viewer-kind">{mime}</span>
        <button
          type="button"
          className="nb-map-viewer-close"
          aria-label={t('common.close')}
          title={t('common.close')}
          onClick={onClose}
        >
          <X size={15} aria-hidden />
        </button>
      </header>

      <main className="nb-attachment-viewer-stage">
        {mime.startsWith('image/') ? (
          <img src={url} alt={name} draggable={false} />
        ) : mime.startsWith('audio/') ? (
          <div className="nb-attachment-viewer-media">
            <audio controls preload="metadata" src={url} aria-label={name} />
          </div>
        ) : mime.startsWith('video/') ? (
          <div className="nb-attachment-viewer-media">
            <video controls preload="metadata" src={url} aria-label={name} />
          </div>
        ) : (
          <iframe src={url} title={name} sandbox="" />
        )}
      </main>
    </div>,
    document.body,
  );
}
