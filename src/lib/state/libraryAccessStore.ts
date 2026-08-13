import { create } from 'zustand';
import { storage, type LibraryAccessStatus } from '@/lib/adapters';

interface LibraryAccessState {
  status: LibraryAccessStatus | null;
  loaded: boolean;
  refresh(): Promise<void>;
}

/** One small live read shared by the status bar and editor. The native lock
 * heartbeat can downgrade the process after startup, so this is polled rather
 * than treated as immutable bootstrap data. */
export const useLibraryAccessStore = create<LibraryAccessState>((set) => ({
  status: null,
  loaded: false,
  async refresh() {
    const status = await storage.accessStatus();
    set({ status, loaded: true });
  },
}));
