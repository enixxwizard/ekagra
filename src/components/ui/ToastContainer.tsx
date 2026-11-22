import React from 'react';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { useDayFlow } from '../../context/DayFlowContext';

export const ToastContainer: React.FC = () => {
  const { toasts, dismissToast } = useDayFlow();

  if (toasts.length === 0) return null;

  return (
    <div
      aria-live="polite"
      className="fixed right-4 bottom-20 z-50 flex w-[calc(100%-2rem)] max-w-sm flex-col gap-2 pointer-events-none md:bottom-5"
    >
      {toasts.map((toast) => {
        const icon =
          toast.type === 'success' ? (
            <CheckCircle2 className="h-4 w-4 text-[var(--df-accent-soft-fg)] shrink-0" />
          ) : toast.type === 'warning' ? (
            <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0" />
          ) : toast.type === 'error' ? (
            <XCircle className="h-4 w-4 text-rose-600 shrink-0" />
          ) : (
            <Info className="h-4 w-4 text-[var(--df-text)] shrink-0" />
          );

        return (
          <div
            key={toast.id}
            role="status"
            className="pointer-events-auto flex items-start gap-3 rounded-2xl border border-[var(--df-border)] bg-[var(--df-surface)] p-3.5"
          >
            <div className="mt-0.5">{icon}</div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-[var(--df-text)]">
                {toast.title}
              </p>
              {toast.description && (
                <p className="mt-0.5 text-xs text-[var(--df-text-muted)]">
                  {toast.description}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={() => dismissToast(toast.id)}
              aria-label="Dismiss"
              className="rounded-lg p-1 text-[var(--df-text-subtle)] hover:text-[var(--df-text)]"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
};
