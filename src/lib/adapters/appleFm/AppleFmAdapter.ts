export type AppleFmModelState =
  | 'available'
  | 'not_eligible'
  | 'intelligence_off'
  | 'not_ready'
  | 'unknown';

export interface AppleFmPreflight {
  installed: boolean;
  osOk: boolean;
  licensed: boolean;
  model: AppleFmModelState;
  detail: string | null;
}

export interface AppleFmStatus {
  running: boolean;
  port: number | null;
  /** True only when this NotaBene process spawned the server. A healthy server
   * left by a crash is reused but not killed as though it were our child. */
  managed: boolean;
  error: string | null;
}

export interface AppleFmAdapter {
  preflight(): Promise<AppleFmPreflight>;
  start(port?: number): Promise<number>;
  stop(): Promise<void>;
  status(): Promise<AppleFmStatus>;
  countTokens(text: string): Promise<number>;
}
