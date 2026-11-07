// In-app confirmation (instead of the browser's confirm() dialog, which some web views block).

export interface ConfirmRequest {
  title: string;
  detail?: string;
  action: string;
  danger?: boolean;
  resolve: (ok: boolean) => void;
}

let listener: ((req: ConfirmRequest | undefined) => void) | undefined;

export function setConfirmListener(fn: typeof listener) {
  listener = fn;
}

export function confirmAction(title: string, opts: { detail?: string; action?: string; danger?: boolean } = {}): Promise<boolean> {
  return new Promise((resolve) => {
    if (!listener) return resolve(false);
    listener({
      title,
      detail: opts.detail,
      action: opts.action ?? 'OK',
      danger: opts.danger ?? true,
      resolve: (ok) => {
        listener?.(undefined);
        resolve(ok);
      },
    });
  });
}
