/**
 * How AI requests leave the machine.
 *
 * The provider layer (`src/lib/ai/`) builds requests and parses responses; this
 * adapter only carries bytes. Splitting them means the desktop build can route
 * through Rust — dodging CSP and letting the key stay out of the webview — while
 * the browser build uses `fetch`, with no provider code aware of the difference.
 */
export interface AiRequest {
  url: string;
  method: 'POST' | 'GET';
  headers: Record<string, string>;
  body?: string;
  /** Aborts an in-flight request when the user cancels. */
  signal?: AbortSignal;
}

export interface AiResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface AiTransport {
  request(request: AiRequest): Promise<AiResponse>;
  /** Server-sent-event streaming for token-by-token progress. Yields raw SSE
   * `data:` payloads; providers parse their own frame shape. */
  stream(request: AiRequest): AsyncIterable<string>;
}
