// In-app confirmation (instead of the browser's confirm() dialog, which some web views block).

export interface ConfirmRequest {
  title: string;
  detail?: string;
  action: string;
  danger?: boolean;
  /** 0.9.0: ask for a password instead (askPassword). */
  password?: boolean;
  resolve: (ok: boolean, text?: string) => void;
}

let listener: ((req: ConfirmRequest | undefined) => void) | undefined;

export function setConfirmListener(fn: typeof listener) {
  listener = fn;
}

/** 0.9.0: asks for a password in an in-app sheet. Undefined if cancelled. */
export function askPassword(title: string, opts: { detail?: string; action?: string } = {}): Promise<string | undefined> {
  return new Promise((resolve) => {
    if (!listener) return resolve(undefined);
    listener({
      title,
      detail: opts.detail,
      action: opts.action ?? 'OK',
      password: true,
      resolve: (ok, text) => {
        listener?.(undefined);
        resolve(ok && text ? text : undefined);
      },
    });
  });
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
