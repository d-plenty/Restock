// In-app confirmation (instead of the browser's confirm() dialog, which some web views block).

export interface ConfirmRequest {
  title: string;
  detail?: string;
  action: string;
  danger?: boolean;
  /** 0.9.0: ask for a password instead (askPassword). */
  password?: boolean;
  /** 0.9.5 (save): several buttons instead of one (askLeave); `text` is the id of the one picked. */
  choices?: { id: string; label: string; kind?: 'primary' | 'save' | 'danger' }[];
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

/**
 * 0.9.5 (save): leaving a settings screen with changes not saved. "Save" saves them first; "Discard"
 * throws them away; "Keep editing" (or closing the sheet) stays.
 */
export function askLeave(): Promise<'save' | 'discard' | 'keep'> {
  return new Promise((resolve) => {
    if (!listener) return resolve('keep');
    listener({
      title: 'Save your changes?',
      detail: "You changed settings on this page and haven't saved them yet.",
      action: 'Save',
      choices: [
        { id: 'save', label: 'Save', kind: 'save' },
        { id: 'discard', label: 'Discard', kind: 'danger' },
        { id: 'keep', label: 'Keep editing' },
      ],
      resolve: (ok, text) => {
        listener?.(undefined);
        resolve(ok && (text === 'save' || text === 'discard') ? text : 'keep');
      },
    });
  });
}

/**
 * 0.9.5 (review): signing out of the web app while changes made here (offline, say) haven't reached
 * the server: they go with this browser's copy. True: sign out anyway. Without the in-app sheet,
 * the browser's own confirm.
 */
export const UNSENT_TITLE = "You have changes that haven't reached the server yet. Sign out anyway and lose them?";
export function askSignOutUnsent(): Promise<boolean> {
  return new Promise((resolve) => {
    if (!listener) return resolve(typeof window !== 'undefined' && typeof window.confirm === 'function' ? window.confirm(UNSENT_TITLE) : false);
    listener({
      title: UNSENT_TITLE,
      action: 'Sign out',
      danger: true,
      choices: [
        { id: 'stay', label: 'Stay signed in', kind: 'primary' },
        { id: 'out', label: 'Sign out', kind: 'danger' },
      ],
      resolve: (ok, text) => {
        listener?.(undefined);
        resolve(ok && text === 'out');
      },
    });
  });
}
