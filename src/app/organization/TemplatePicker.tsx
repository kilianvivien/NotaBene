import { FileStack } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Dialog, GlassButton } from '@/components/glass';
import { createNoteFromTemplateCommand } from '@/lib/commands';
import { useEditorStore } from '@/lib/state/editorStore';
import { useLibraryStore } from '@/lib/state/libraryStore';
import { useUiStore } from '@/lib/state/uiStore';

export function TemplatePicker() {
  const { t } = useTranslation();
  const templates = useLibraryStore((state) => state.templates);
  const courses = useLibraryStore((state) => state.courses);
  const open = useUiStore((state) => state.templatePickerOpen);
  const setOpen = useUiStore((state) => state.setTemplatePickerOpen);
  const selectNote = useUiStore((state) => state.selectNote);
  const openNote = useEditorStore((state) => state.openNote);

  return (
    <Dialog
      open={open}
      onClose={() => setOpen(false)}
      title={t('organization.newFromTemplate')}
      size="md"
      footer={
        <GlassButton size="sm" onClick={() => setOpen(false)}>
          {t('common.close')}
        </GlassButton>
      }
    >
      <div className="space-y-1">
        {templates.length ? (
          templates.map((template) => (
            <button
              key={template.id}
              type="button"
              className="flex w-full items-center gap-3 rounded-nb-sm p-3 text-left hover:bg-[var(--nb-hover)]"
              onClick={() => {
                void createNoteFromTemplateCommand(template).then(async (result) => {
                  if (!result.ok) return;
                  selectNote(result.value.id);
                  await openNote(result.value.id);
                  setOpen(false);
                });
              }}
            >
              <FileStack size={17} className="shrink-0 text-[var(--nb-accent)]" />
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-medium">
                  {template.name}
                </span>
                <span className="block truncate text-[12px] text-nb-text-3">
                  {template.courseId
                    ? courses.find((course) => course.id === template.courseId)?.name
                    : t('organization.globalTemplate')}
                </span>
              </span>
            </button>
          ))
        ) : (
          <p className="py-8 text-center text-[12px] text-nb-text-3">
            {t('organization.noTemplates')}
          </p>
        )}
      </div>
    </Dialog>
  );
}
