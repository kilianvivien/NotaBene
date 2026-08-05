/**
 * A scrolling region that says so.
 *
 * Every panel in the app that puts a body between a fixed header and a fixed
 * footer had the same failing: the body ended in a hard line, and whatever row
 * happened to land there was sliced through the middle. That reads as a
 * rendering bug rather than as "there is more below". This fades at whichever
 * edge is actually cut off, and only then.
 *
 * The fades live on the wrapper rather than the scroller, because a
 * pseudo-element inside a scroll container is part of the scrolled content and
 * travels away with it.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils/cn';

export function GlassScrollArea({
  /** Change it to send the region back to its own top — a settings pane, a
   * dialog step. Carrying the last view's scroll position into a shorter one
   * puts the reader halfway down a page they have not opened yet. */
  resetKey,
  className,
  children,
}: {
  resetKey?: string | number;
  /** Padding for the scrolling content. The wrapper stays flush so the fades
   * can reach the region's edges. */
  className?: string;
  children: ReactNode;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ top: false, bottom: false });

  const measure = useCallback((): void => {
    const element = scroller.current;
    if (!element) return;
    const { scrollTop, scrollHeight, clientHeight } = element;
    setEdges({
      top: scrollTop > 1,
      bottom: scrollTop + clientHeight < scrollHeight - 1,
    });
  }, []);

  // Content that grows on its own — a provider row opening, a voice list
  // arriving, an answer streaming in — has to re-answer the question, so the
  // observer holds the same callback the scroll handler does.
  useEffect(() => {
    const element = content.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [measure]);

  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0;
    measure();
  }, [resetKey, measure]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        onScroll={measure}
        className={cn('min-h-0 flex-1 overflow-y-auto', className)}
      >
        <div ref={content}>{children}</div>
      </div>
      <span
        aria-hidden
        className="nb-scroll-fade nb-scroll-fade-top"
        data-on={edges.top || undefined}
      />
      <span
        aria-hidden
        className="nb-scroll-fade nb-scroll-fade-bottom"
        data-on={edges.bottom || undefined}
      />
    </div>
  );
}
