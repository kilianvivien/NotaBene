import { create } from 'zustand';

interface AttachmentState {
  revision: number;
  changed(): void;
}

/** Invalidate panels that read attachment rows directly from the adapter. */
export const useAttachmentStore = create<AttachmentState>((set) => ({
  revision: 0,
  changed: () => set((state) => ({ revision: state.revision + 1 })),
}));

export function attachmentsChanged(): void {
  useAttachmentStore.getState().changed();
}
