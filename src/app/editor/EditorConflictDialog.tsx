import { useTranslation } from 'react-i18next';
import { Dialog, GlassButton } from '@/components/glass';
import { useEditorStore } from '@/lib/state/editorStore';

export function EditorConflictDialog() {
  const { t } = useTranslation();
  const conflict = useEditorStore((state) => state.conflict);
  const resolve = useEditorStore((state) => state.resolveConflict);
  return (
    <Dialog
      open={conflict !== null}
      onClose={() => {}}
      title={t('editorConflict.title')}
      description={t('editorConflict.description')}
      footer={
        <>
          <GlassButton onClick={() => void resolve('theirs')}>
            {t('editorConflict.takeTheirs')}
          </GlassButton>
          <GlassButton variant="accent" onClick={() => void resolve('mine')}>
            {t('editorConflict.keepMine')}
          </GlassButton>
        </>
      }
    >
      <p className="text-[12px] text-nb-text-2">{t('editorConflict.body')}</p>
    </Dialog>
  );
}
