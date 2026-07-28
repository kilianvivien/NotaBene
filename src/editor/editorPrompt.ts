/**
 * `window.prompt` is a no-op in the WKWebView Tauri runs on macOS: wry supplies
 * the alert and confirm panels but not the text-input one, so the call returns
 * null and the caller quietly does nothing. That is why inserting an equation
 * appeared dead in the desktop build while it worked in `pnpm dev`.
 *
 * Every prompt the editor raises goes through this bridge to a real dialog
 * instead. It is a bridge rather than a hook because one of the callers — the
 * math node view — is plain ProseMirror and sits outside the React tree, the
 * same reason `commandBridge` exists.
 */
export interface EditorPromptRequest {
  title: string;
  value: string;
  /** Render the value as an equation under the field as it is typed. */
  math?: boolean;
  placeholder?: string;
}

type Handler = (request: EditorPromptRequest) => Promise<string | null>;

let handler: Handler | null = null;

export function registerEditorPrompt(next: Handler): () => void {
  handler = next;
  return () => {
    if (handler === next) handler = null;
  };
}

/** Resolves to the entered text, or null if the dialog was dismissed. */
export async function editorPrompt(
  request: EditorPromptRequest,
): Promise<string | null> {
  return (await handler?.(request)) ?? null;
}
