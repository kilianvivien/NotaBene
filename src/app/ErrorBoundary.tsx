import { Component, type ErrorInfo, type ReactNode } from 'react';
import i18n from '@/lib/i18n';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Last line of defence for a render crash. The reassurance in the copy is not
 * decoration: autosave has already flushed to disk, so a reload genuinely does
 * cost nothing. Saying so is what stops a panicked student from retyping a
 * lecture.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Local only — NotaBene has no telemetry, so this never leaves the machine.
    console.error('NotaBene crashed while rendering', error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;

    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <h1 className="text-[17px] font-semibold">{i18n.t('error.boundaryTitle')}</h1>
        <p className="max-w-[42ch] text-[13px] text-nb-text-2">
          {i18n.t('error.boundaryBody')}
        </p>
        <pre className="mono max-w-[60ch] overflow-x-auto rounded-nb-sm bg-[var(--nb-code-bg)] p-3 text-left text-[11px]">
          {this.state.error.message}
        </pre>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="h-9 rounded-nb-sm bg-[var(--nb-accent)] px-4 text-[13px] font-medium text-[var(--nb-text-on-accent)]"
        >
          {i18n.t('error.reload')}
        </button>
      </div>
    );
  }
}
