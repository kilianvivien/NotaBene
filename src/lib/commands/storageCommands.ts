import i18n from '@/lib/i18n';
import { appLifecycle, dialog, storage } from '@/lib/adapters';
import { useEditorStore } from '@/lib/state/editorStore';
import { useLibraryAccessStore } from '@/lib/state/libraryAccessStore';
import { useSettingsStore } from '@/lib/state/settingsStore';
import { fail, ok, type CommandResult } from './types';

function relocationMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('LIBRARY_DESTINATION_IN_USE')) {
    return i18n.t('storage.moveErrorInUse');
  }
  if (message.includes('LIBRARY_LOCATION_INVALID')) {
    return i18n.t('storage.moveErrorInvalid');
  }
  if (message.includes('LIBRARY_COPY_INVALID')) {
    return i18n.t('storage.moveErrorVerify');
  }
  if (message.includes('LIBRARY_READ_ONLY')) {
    return i18n.t('storage.moveErrorReadOnly');
  }
  return message;
}

/** Flush, prepare or verify the destination, switch the setting, then relaunch.
 * The Rust command never receives authority to remove or overwrite a library. */
export async function relocateLibraryCommand(): Promise<CommandResult<boolean>> {
  const status = useLibraryAccessStore.getState().status;
  if (status?.readOnly)
    return fail('storage_failed', i18n.t('storage.moveErrorReadOnly'));

  const destination = await dialog.openFolder();
  if (!destination || destination === status?.libraryDir) return ok(false);
  const confirmed = await dialog.confirm(i18n.t('storage.moveConfirm'), {
    title: i18n.t('storage.changeLocation'),
  });
  if (!confirmed) return ok(false);

  await useEditorStore.getState().flush();
  if (useEditorStore.getState().saveState === 'error') {
    return fail('storage_failed', i18n.t('storage.moveErrorUnsaved'));
  }

  try {
    const libraryLocation = await storage.relocateLibrary(destination);
    await useSettingsStore.getState().update({ libraryLocation });
    await appLifecycle.relaunch();
    return ok(true);
  } catch (error) {
    return fail('storage_failed', relocationMessage(error));
  }
}
