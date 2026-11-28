// 0.18.3: "Is this you?" on an admin phone. While Restock is open (and in the front) on an admin
// phone, it asks the server every 10 seconds whether a browser is waiting for a yes: signing in to
// the server's page with the passphrase, or a risky change there. Each one shows as a sheet
// (ApprovalSheet.tsx) with the number the browser shows, which browser, from where, and Yes or No.
// A phone can't be woken for it (iPhones don't let apps check in the background, Android only every
// 15 minutes), so the server's page says to open Restock on the phone.
import { useSyncExternalStore } from 'react';
import { approvals, me, type Approval } from './serverAdmin';
import { syncInfo } from './sync';

const EVERY_MS = 10_000;
let waiting: Approval[] = [];
const answered = new Set<string>();
const listeners = new Set<() => void>();
const tell = () => listeners.forEach((f) => f());

/** Server 0.18.3 or newer: it has requests for a yes. */
const knowsApprovals = (v?: string) => {
  const [a, b, c] = String(v ?? '')
    .split('.')
    .map((x) => Number.parseInt(x, 10) || 0);
  return a > 0 || b > 18 || (b === 18 && c >= 3);
};

let admin: boolean | undefined;
let checkedRoleAt = 0;
async function isAdminHere(): Promise<boolean> {
  // The role is asked again every 5 minutes (it can change on the web page).
  if (admin !== undefined && Date.now() - checkedRoleAt < 5 * 60_000) return admin;
  const info = await syncInfo();
  if (!info.server || info.serverApi !== 3) return (admin = false);
  try {
    const m = await me();
    admin = m.role === 'admin' && knowsApprovals(m.server);
  } catch {
    admin = false;
  }
  checkedRoleAt = Date.now();
  return admin;
}

/** Looks once now. Exported for Server admin (it looks when it opens) and the tests. */
export async function lookForApprovals(): Promise<Approval[]> {
  if (!(await isAdminHere())) {
    if (waiting.length) {
      waiting = [];
      tell();
    }
    return [];
  }
  const list = (await approvals().catch(() => waiting)).filter((a) => !answered.has(a.id) && Date.parse(a.expires) > Date.now());
  if (list.map((a) => a.id).join() !== waiting.map((a) => a.id).join()) {
    waiting = list;
    if (list.length) onFirst?.();
    tell();
  }
  return list;
}

/** Done with one (answered, or dismissed): it's not shown again. */
export function doneWith(id: string): void {
  answered.add(id);
  waiting = waiting.filter((a) => a.id !== id);
  tell();
}

let timer: ReturnType<typeof setInterval> | undefined;
let onFirst: (() => void) | undefined;
/**
 * Starts looking while Restock is in the front; stops in the background. Called once at start.
 * `found`: the first time one is waiting (the app loads the sheet then, not before).
 */
export function watchApprovals(found?: () => void): void {
  onFirst = found;
  if (typeof document === 'undefined' || timer) return;
  const tick = () => {
    if (document.visibilityState === 'visible') void lookForApprovals().catch(() => undefined);
  };
  timer = setInterval(tick, EVERY_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      checkedRoleAt = 0;
      tick();
    }
  });
  tick();
}

export function useApprovals(): Approval[] {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => waiting,
    () => waiting,
  );
}
