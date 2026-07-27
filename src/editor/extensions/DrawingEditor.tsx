import { useRef } from 'react';
import {
  Excalidraw,
  exportToSvg,
} from '@excalidraw/excalidraw';
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

export default function DrawingEditor({ data, onCancel, onSave }: DrawingEditorProps) {
  const { t } = useTranslation();
  const latest = useRef<Scene | null>(null);

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
          UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false } }}
        />
      </div>
    </div>
  );
}
