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
      // Not the menu item's label: a trailing ellipsis means "this opens a
      // dialog", and inside that dialog it is a promise already kept.
      title={t('organization.templatePickerTitle')}
      description={t('organization.templatePickerHint')}
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
          <div className="flex flex-col items-center gap-2 py-8 text-center text-nb-text-3">
            <FileStack size={24} aria-hidden />
            <p className="text-[13px] text-nb-text-2">{t('organization.noTemplates')}</p>
            <p className="max-w-[42ch] text-[11.5px] leading-snug">
              {t('organization.noTemplatesHint')}
            </p>
          </div>
        )}
      </div>
    </Dialog>
  );
}
