// 0.9.5: what main.tsx calls for the home screen web app: the service worker, opening offline,
// and making sure nothing of a signed-out session stays on this browser.
import { ApiError, setServerInfo, type ServerInfo } from '../api';
import { deleteLocalCopy, onStatus, syncStatus } from '../live';
import { recall, type Session } from '../session';
import { clearState, forgetKept, hasCopy, isOfflineError, keepInfo, keptInfo, markBootOffline, offlineSession, openedCopy, pwaState, roundDone, staleCopy, WEBID_KEY } from './offline';
import { registerServiceWorker } from './register';

const store = (): Storage | undefined => {
  try {
    return localStorage;
  } catch {
    return undefined;
  }
};
const copyOf = () => {
  try {
    return localStorage.getItem(WEBID_KEY);
  } catch {
    return null;
  }
};

export function startPwa(): void {
  registerServiceWorker();
}

/** The server answered what it is: keep it for opening offline. */
export function noteServer(info: ServerInfo): void {
  const s = store();
  if (s) keepInfo(s, info);
}

/**
 * The server can't be reached: the session to open this browser's copy with, offline, or
 * undefined (then the usual "Can't reach your Restock server" page shows).
 */
export async function openOffline(e: unknown): Promise<Session | undefined> {
  if (!(e instanceof ApiError) || e.status !== 0) return undefined;
  const st = store();
  const info = st ? keptInfo(st) : undefined;
  if (!info || info.mode === 'new') return undefined;
  const s = offlineSession(recall(), copyOf());
  if (!s || !(await hasCopy(s.webId))) return undefined;
  setServerInfo(info);
  markBootOffline();
  return s;
}

/** At the sign-in page of a house: a copy no session here can open any more goes now. */
export async function atSignIn(): Promise<void> {
  clearState();
  const old = staleCopy(copyOf(), recall());
  if (!old) return;
  await deleteLocalCopy(old);
  const st = store();
  if (st) forgetKept(st);
}

/** Signed out (here, everywhere, or the session ran out): what's kept for offline goes too. */
export function signedOut(): void {
  clearState();
  const st = store();
  if (st) forgetKept(st);
}

/** The app opened on this session's copy: note when each round brings the list up to date. */
export function watchCopy(webId: string): () => void {
  void openedCopy(webId);
  let seen = syncStatus().at;
  return onStatus(() => {
    const st = syncStatus();
    if (st.at && st.at !== seen && !st.error) {
      seen = st.at;
      roundDone(st.at);
    }
  });
}

/** 0.9.6 (offline): offline right now? (As the notice's useIsOffline, outside React.) */
export function offlineNow(): boolean {
  const p = pwaState();
  const st = syncStatus();
  return p.noNetwork || isOfflineError(st.error) || (p.bootOffline && !st.at);
}
