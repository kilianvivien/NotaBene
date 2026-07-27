/**
 * Server-sent-event reframing.
 *
 * Both transports receive arbitrary byte chunks and owe their caller whole
 * `data:` payloads, so the buffering rule — an event ends at a blank line, and
 * anything short of that is a partial frame we must hold onto — is written
 * once here rather than once per transport.
 */
export class SseBuffer {
  private buffer = '';

  /** Feed a raw chunk; get back whatever complete `data:` payloads it completed. */
  push(chunk: string): string[] {
    this.buffer += chunk;
    const payloads: string[] = [];

    let boundary = this.nextBoundary();
    while (boundary) {
      const frame = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary.length);
      for (const line of frame.split('\n')) {
        // Comment lines (`: keep-alive`) and `event:` lines carry no payload;
        // providers that use `event:` also repeat the type inside the JSON.
        if (line.startsWith('data:')) payloads.push(line.slice(5).trim());
      }
      boundary = this.nextBoundary();
    }
    return payloads;
  }

  /** Some providers end without a trailing blank line. */
  flush(): string[] {
    if (!this.buffer.trim()) {
      this.buffer = '';
      return [];
    }
    const remainder = this.buffer;
    this.buffer = '';
    return remainder
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim());
  }

  private nextBoundary(): { index: number; length: number } | null {
    const lf = this.buffer.indexOf('\n\n');
    const crlf = this.buffer.indexOf('\r\n\r\n');
    if (lf === -1 && crlf === -1) return null;
    if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 };
    return { index: lf, length: 2 };
  }
}
