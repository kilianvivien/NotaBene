/**
 * A side pane that collapses by width instead of unmounting.
 *
 * Toggling the sidebar used to be a jump cut: the pane vanished and everything
 * to its right snapped left. Animating the width means the note list slides
 * into the space, which is both calmer and easier to follow — you can see where
 * the pane went, so finding it again is not a hunt.
 *
 * The pane stays mounted while collapsed, so it also keeps its scroll position.
 * `inert` is what keeps that honest: a zero-width pane must not be reachable by
 * Tab or readable by VoiceOver just because it is technically still there.
 */
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils/cn';

interface CollapsiblePaneProps {
  open: boolean;
  /** The pane's own width, in pixels. Its child keeps this width throughout,
   * so the content never reflows on the way out. */
  width: number;
  children: ReactNode;
}

export function CollapsiblePane({ open, width, children }: CollapsiblePaneProps) {
  return (
    <div
      inert={!open}
      aria-hidden={!open}
      className={cn('pane-collapse shrink-0 overflow-hidden', !open && 'opacity-0')}
      style={{ width: open ? width : 0 }}
    >
      <div style={{ width }} className="h-full">
        {children}
      </div>
    </div>
  );
}
