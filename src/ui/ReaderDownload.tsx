import { useEffect, useRef, useState } from 'react';
import { readerInstalled } from '../lib/receiptReader';
import { downloadReader, READER_SIZE_TEXT, READER_WHAT, readerDownloaded, removeReader } from '../lib/readerModels';
import { deviceWord } from '../lib/platform';
import { Sheet } from './components';
import { useNav } from './nav';

// The photo reader's download: asked for the first time the reader is wanted (a receipt, or adding
// something from a photo of its pack), and a row in Settings to remove it or get it again.

/** The progress of a download, as a bar and the megabytes so far. */
function Progress({ done, total }: { done: number; total: number }) {
  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return (
    <>
      <div className="loading-bar" role="progressbar" aria-label="Downloading the photo reader" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <span style={{ width: `${pct}%` }} />
      </div>
      <span className="small" role="status">
        {(done / 1_000_000).toFixed(1)} of {(total / 1_000_000).toFixed(0)} MB
      </span>
    </>
  );
}

function useDownload(onDone?: () => void) {
  const [progress, setProgress] = useState<{ done: number; total: number }>();
  const [error, setError] = useState<string>();
  const stop = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => stop.current?.abort(), []);
  const start = async () => {
    setError(undefined);
    setProgress({ done: 0, total: 1 });
    stop.current = new AbortController();
    try {
      await downloadReader((done, total) => setProgress({ done, total }), { signal: stop.current.signal });
      setProgress(undefined);
      onDone?.();
    } catch (e) {
      setProgress(undefined);
      if (stop.current?.signal.aborted) return;
      const said = e instanceof Error ? e.message : String(e);
      setError(typeof navigator !== 'undefined' && navigator.onLine === false ? 'You’re offline. Try again when you have a connection.' : `Couldn’t download it: ${said}`);
    }
  };
  return { progress, error, start, busy: !!progress };
}

/** Asks before downloading, showing the size and what it's for. `onClose(true)` once the reader is ready. */
function ReaderDownloadSheet({ onClose }: { onClose: (ready: boolean) => void }) {
  const d = useDownload(() => onClose(true));
  return (
    <Sheet title="Download the photo reader?" onClose={() => onClose(false)}>
      <p style={{ margin: 0 }}>{READER_WHAT}</p>
      <p className="small" style={{ margin: 0 }}>
        About {READER_SIZE_TEXT}, downloaded once from Restock on GitHub. Photos are read on this {deviceWord()}: none are sent anywhere. You can remove
        it any time in Settings.
      </p>
      {d.progress && <Progress {...d.progress} />}
      {d.error && (
        <div className="banner amber" role="alert">
          <span style={{ fontSize: 13 }}>{d.error}</span>
        </div>
      )}
      <div className="two">
        <button className="btn" onClick={() => onClose(false)}>
          Not now
        </button>
        <button className="btn primary" disabled={d.busy} onClick={() => void d.start()}>
          {d.busy ? 'Downloading…' : d.error ? 'Try again' : `Download (${READER_SIZE_TEXT})`}
        </button>
      </div>
    </Sheet>
  );
}

/**
 * For a screen that reads photos: `ensure()` resolves true when the reader is ready, asking to
 * download it first if it isn't here. Put `sheet` somewhere in the screen.
 */
export function useReaderGate() {
  const [asking, setAsking] = useState<{ answer: (ready: boolean) => void }>();
  const ensure = async (): Promise<boolean> => {
    if (await readerInstalled()) return true;
    return new Promise<boolean>((answer) => setAsking({ answer }));
  };
  const sheet = asking ? (
    <ReaderDownloadSheet
      onClose={(ready) => {
        asking.answer(ready);
        setAsking(undefined);
      }}
    />
  ) : null;
  return { ensure, sheet };
}

/** Settings: the photo reader, downloaded or not, with Download or Remove. Not shown where it's built in. */
export function ReaderSettings() {
  const nav = useNav();
  const [here, setHere] = useState<boolean>();
  const d = useDownload(() => {
    setHere(true);
    nav.toast('The photo reader is ready.');
  });
  useEffect(() => {
    void readerDownloaded().then(setHere);
  }, []);
  return (
    <div className="card" style={{ gap: 10 }}>
      <div>
        <div className="title">Photo reader</div>
        <div className="small">
          Reads receipts and product names from photos. {here === undefined ? '' : here ? `Downloaded · ${READER_SIZE_TEXT}` : `Not downloaded · ${READER_SIZE_TEXT}`}
        </div>
      </div>
      {d.progress && <Progress {...d.progress} />}
      {d.error && (
        <span className="small" role="alert" style={{ color: 'var(--red-ink)' }}>
          {d.error}
        </span>
      )}
      {here ? (
        <button
          className="btn small"
          style={{ alignSelf: 'flex-start' }}
          onClick={() =>
            void removeReader().then(() => {
              setHere(false);
              nav.toast('Photo reader removed. Download it again any time.');
            })
          }
        >
          Remove
        </button>
      ) : (
        <button className="btn small primary" style={{ alignSelf: 'flex-start' }} disabled={d.busy || here === undefined} onClick={() => void d.start()}>
          {d.busy ? 'Downloading…' : 'Download'}
        </button>
      )}
    </div>
  );
}
