import { useRef } from 'react';
import { Excalidraw, exportToSvg } from '@excalidraw/excalidraw';
import type {
  ExcalidrawInitialDataState,
  ExcalidrawProps,
} from '@excalidraw/excalidraw/types';
import '@excalidraw/excalidraw/index.css';
import { useTranslation } from 'react-i18next';

type DrawingData = ExcalidrawInitialDataState;
type SceneChange = NonNullable<ExcalidrawProps['onChange']>;
type Scene = Parameters<SceneChange>;

interface DrawingEditorProps {
  data: DrawingData;
  onCancel(): void;
  onSave(data: DrawingData, svg: string): void;
}

/** Excalidraw ships its own translations but defaults to English unless it is
 * told otherwise, so without this the canvas stayed English inside a French
 * app — the drawing tools, the Library panel and the whole Mermaid dialog. Its
 * codes are not ours: `fr` is `fr-FR` there, and anything unknown falls back to
 * English on its side. */
const EXCALIDRAW_LANGUAGES: Record<string, string> = { fr: 'fr-FR', en: 'en' };

export default function DrawingEditor({ data, onCancel, onSave }: DrawingEditorProps) {
  const { t, i18n } = useTranslation();
  const latest = useRef<Scene | null>(null);
  const langCode = EXCALIDRAW_LANGUAGES[i18n.language.split('-')[0] ?? 'en'] ?? 'en';

  const handleChange: SceneChange = (elements, appState, files) => {
    latest.current = [elements, appState, files];
  };

  async function save() {
    const [elements, appState, files] = latest.current ?? [
      data.elements ?? [],
      data.appState ?? {},
      data.files ?? {},
    ];
    const svg = await exportToSvg({
      elements,
      appState: {
        ...appState,
        exportBackground: false,
        viewBackgroundColor: 'transparent',
      },
      files,
    });
    onSave(
      {
        elements,
        appState: {
          viewBackgroundColor: appState.viewBackgroundColor,
          gridSize: appState.gridSize,
        },
        files,
      },
      svg.outerHTML,
    );
  }

  return (
    <div className="nb-drawing-modal" contentEditable={false}>
      <div className="nb-drawing-modal-bar">
        <strong>{t('editor.drawing')}</strong>
        <span className="flex-1" />
        <button type="button" onClick={onCancel}>
          {t('common.cancel')}
        </button>
        <button type="button" className="nb-primary-action" onClick={() => void save()}>
          {t('common.confirm')}
        </button>
      </div>
      <div className="nb-excalidraw-shell">
        <Excalidraw
          initialData={data}
          onChange={handleChange}
          theme={document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'}
          langCode={langCode}
          UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false } }}
        />
      </div>
    </div>
  );
}
