// 0.9.5: "On iPhone?": how to put the web app on a phone's home screen, what works offline, and
// that it needs the server's https address. Plain steps; on Android Chrome an Install button too.
import { useEffect, useState } from 'react';
import { Icon, Sheet } from '../../ui/components';
import './pwa.css';

interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

// Chrome on Android offers its own install prompt once; keep it for the Install button.
let deferred: InstallPrompt | undefined;
const promptSubs = new Set<() => void>();
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as InstallPrompt;
    promptSubs.forEach((f) => f());
  });
  window.addEventListener('appinstalled', () => {
    deferred = undefined;
    promptSubs.forEach((f) => f());
  });
}

/** Open from the home screen (standalone), not in a browser tab? */
export function isInstalled(): boolean {
  if (typeof window === 'undefined') return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true || !!window.matchMedia?.('(display-mode: standalone)').matches;
}

/** An iPhone or iPad (iPads say they're Macs, but have touch). */
export function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
}

function useInstallPrompt(): InstallPrompt | undefined {
  const [p, setP] = useState(deferred);
  useEffect(() => {
    const f = () => setP(deferred);
    promptSubs.add(f);
    return () => void promptSubs.delete(f);
  }, []);
  return p;
}

export function InstallSheet({ onClose }: { onClose: () => void }) {
  const secure = typeof window !== 'undefined' && window.isSecureContext && location.protocol === 'https:';
  const prompt = useInstallPrompt();
  const installed = isInstalled();
  return (
    <Sheet title="Restock on iPhone" onClose={onClose}>
      <p style={{ margin: 0 }}>Put Restock on your home screen. It opens like an app, and your lists, pantry and cards work with no signal.</p>
      {installed ? (
        <p className="pwa-note good">
          <Icon name="check" size={18} /> Restock is on this phone's home screen.
        </p>
      ) : !secure ? (
        <p className="pwa-note warn">
          <Icon name="alert" size={18} /> This page isn't on an https address, so it can't go on the home screen or use the camera. Open the server's https address
          instead (for example your Cloudflare tunnel).
        </p>
      ) : null}
      <h3 className="pwa-h">On iPhone</h3>
      <ol className="pwa-steps">
        <li>Open the server's https address in Safari.</li>
        <li>
          Tap Share <Icon name="share" size={16} />, then <strong>Add to Home Screen</strong>.
        </li>
        <li>Tap Add. Open Restock from your home screen and sign in.</li>
        <li>
          Tick <strong>Keep me signed in</strong>, so it still opens when you're offline.
        </li>
      </ol>
      <h3 className="pwa-h">On Android</h3>
      <p style={{ margin: 0 }}>
        Open the https address in Chrome, then tap the menu and <strong>Add to Home screen</strong> (or <strong>Install app</strong>).
      </p>
      {prompt && (
        <button
          className="btn primary"
          onClick={() => {
            void prompt.prompt();
            void prompt.userChoice.finally(() => {
              deferred = undefined;
              promptSubs.forEach((f) => f());
            });
          }}
        >
          <Icon name="download" size={18} /> Install Restock
        </button>
      )}
      <h3 className="pwa-h">With no signal</h3>
      {/* 0.9.6 (iPhone offline): everything this phone last saved, and edits wait for signal. */}
      <ul className="pwa-steps">
        <li>Open Restock once with signal first, and sign in with Keep me signed in ticked.</li>
        <li>Your Pantry, Keg and Health tabs open, and all four lists (Groceries, Keg, Health, General). Tick, add, edit, Move to and Undo all work.</li>
        <li>Your cards open, with their barcodes.</li>
        <li>Specials, catalogues and price history show as this phone last saved them.</li>
        <li>Scanning a barcode adds things you already have in your pantry.</li>
        <li>Your changes go to the server when you're back online. A notice says when this phone last saved.</li>
        <li>Searching the shops, the Data tab (and Import), Server and phones, and Activity need signal.</li>
      </ul>
      <p className="small" style={{ margin: 0 }}>
        It needs the https address: iPhones only keep a web app for offline, and only let it use the camera, on https. If the iPhone runs low on space, iOS
        can clear what Restock saved: it loads again next time you're online, but changes not sent yet are lost. Sign out and the household's copy is taken off
        this phone.
      </p>
      <button className="btn" onClick={onClose}>
        Done
      </button>
    </Sheet>
  );
}

/** "On iPhone?": opens the steps. */
export function InstallHelpLink({ className = 'linkish small' }: { className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>
        <Icon name="phone" size={16} /> On iPhone?
      </button>
      {open && <InstallSheet onClose={() => setOpen(false)} />}
    </>
  );
}
