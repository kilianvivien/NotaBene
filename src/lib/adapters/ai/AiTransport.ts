/**
 * How AI requests leave the machine.
 *
 * The provider layer (`src/lib/ai/`) builds requests and parses responses; this
 * adapter only carries bytes. Splitting them means the desktop build can route
 * through Rust — dodging CSP and letting the key stay out of the webview — while
 * the browser build uses `fetch`, with no provider code aware of the difference.
 */
/**
 * A transcription window sent as `multipart/form-data` (plan §10.3). It names
 * the audio — a job and a window — and the desktop transport reads the file
 * in Rust, so a lecture never passes through the webview on its way out.
 */
export interface AiAudioBody {
  /** Plain form fields, in order; a name may repeat, which is how a list
   * travels in a form. */
  fields: [name: string, value: string][];
  fileField: string;
  jobId: string;
  index: number;
}

export interface AiRequest {
  url: string;
  method: 'POST' | 'GET';
  headers: Record<string, string>;
  body?: string;
  /** Instead of `body`, never with it. Desktop only. */
  audio?: AiAudioBody;
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
