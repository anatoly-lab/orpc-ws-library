// Minimal toast overlay for the bidi demo.
//
// Pure presentational component: it renders whatever toasts `App` holds and
// reports dismissals upward. It has NO knowledge of the WS — the toasts arrive
// via the `showToast` server→client handler in `App`, which is the point: the
// transport pushes data, plain React renders it.

import type { ReactElement } from "react";

import styles from "./ToastStack.module.css";

/** A single server-pushed toast. `id` is a stable React key + dismiss handle. */
export interface Toast {
  id: number;
  text: string;
}

export interface ToastStackProps {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}

export function ToastStack({
  toasts,
  onDismiss,
}: ToastStackProps): ReactElement | null {
  if (toasts.length === 0) return null;

  return (
    <div className={styles.stack} data-testid="toast-stack">
      {toasts.map((toast) => (
        <div key={toast.id} className={styles.toast} data-testid="toast">
          <span>{toast.text}</span>
          <button
            type="button"
            className={styles.close}
            aria-label="Dismiss"
            onClick={() => onDismiss(toast.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
