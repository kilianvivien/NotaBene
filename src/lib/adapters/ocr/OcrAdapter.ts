import type { OcrPage } from '@/lib/schema';

/**
 * On-device text recognition, one page at a time.
 *
 * Page-at-a-time on purpose: recognition is N short operations, so the caller
 * loops and gets an exact `page of total` count and cancellation for free.
 * Nothing here holds state between pages.
 */
export interface OcrAdapter {
  /** Whether this build can read a page at all. False disables the offer
   *  rather than failing at the moment the student accepts it. */
  available(): Promise<boolean>;
  /** Recognition languages this machine supports, best first. Surfaced
   *  because a French page read as English comes back as nonsense. */
  languages(): Promise<string[]>;
  /**
   * @param image a rendered page. **Must not carry an alpha channel** — Vision
   * returns no observations and no error for one, so a legible page reads as
   * blank. `rasterisePdfPage` renders JPEG for exactly this reason, and the
   * Rust side refuses an alpha PNG loudly.
   * @param languages empty means "detect from the page".
   */
  recognizePage(image: Blob, languages: string[]): Promise<OcrPage>;
}
