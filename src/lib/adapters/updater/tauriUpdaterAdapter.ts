import { check } from '@tauri-apps/plugin-updater';
import {
  UpdaterUnavailableError,
  type AvailableUpdate,
  type UpdaterAdapter,
  type UpdaterUnavailableReason,
} from './UpdaterAdapter';

/** A build with no public key or endpoint is a packaging problem, not
 * something retrying will fix, so it is told apart from a network failure. */
function classify(error: unknown): UpdaterUnavailableReason {
  const message = String(
    (error as { message?: string } | undefined)?.message ?? error ?? '',
  ).toLowerCase();
  if (
    message.includes('pubkey') ||
    message.includes('public key') ||
    message.includes('minisign') ||
    message.includes('endpoint')
  ) {
    return 'not-configured';
  }
  return 'network';
}

export const tauriUpdaterAdapter: UpdaterAdapter = {
  supported: true,

  async check(): Promise<AvailableUpdate | null> {
    let update: Awaited<ReturnType<typeof check>>;
    try {
      update = await check();
    } catch (error) {
      throw new UpdaterUnavailableError(classify(error), String(error));
    }
    if (!update) return null;
    const handle = update;

    return {
      version: handle.version,
      notes: handle.body || undefined,
      date: handle.date || undefined,
      async install(onProgress) {
        let downloaded = 0;
        let total = 0;
        await handle.downloadAndInstall((event) => {
          if (event.event === 'Started') {
            total = event.data.contentLength ?? 0;
          } else if (event.event === 'Progress') {
            downloaded += event.data.chunkLength;
          } else {
            downloaded = total || downloaded;
          }
          onProgress?.({ downloaded, total });
        });
      },
      async dispose() {
        try {
          await handle.close();
        } catch {
          // Already released — nothing to do.
        }
      },
    };
  },
};

export const unavailableUpdaterAdapter: UpdaterAdapter = {
  supported: false,
  check() {
    return Promise.reject(
      new UpdaterUnavailableError('platform', 'Updates are a desktop feature.'),
    );
  },
};
