import React from 'react';
import { BiIcon } from './ui/BiIcon';

interface ErrorBoundaryState {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      message: error?.message || 'An unexpected error occurred.',
    };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-[var(--df-bg)] p-6 text-[var(--df-text)]">
          <div className="w-full max-w-md rounded-3xl border border-[var(--df-border)] bg-[var(--df-surface)] p-6">
            <div className="mb-3 flex items-center gap-2.5 text-rose-600">
              <BiIcon name="exclamation-triangle" className="text-base shrink-0" />
              <h1 className="font-display text-lg font-bold">Something tripped up</h1>
            </div>
            <p className="mb-5 text-sm leading-relaxed text-[var(--df-text-muted)]">
              {this.state.message}
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="inline-flex items-center gap-2 rounded-xl bg-[var(--df-accent)] px-4 py-2.5 text-sm font-semibold text-[var(--df-accent-fg)]"
            >
              <BiIcon name="arrow-clockwise" className="text-sm" />
              Reload Ekagra
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
