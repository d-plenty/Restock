// 0.9.5: the camera barcode scanner on the web (iPhone Safari, also from the home screen; Android
// Chrome; a laptop's camera). The same decoder the phone app uses (zxing-wasm, bundled with the app:
// nothing is fetched from anywhere), the rear camera, and the camera is only asked for when someone
// presses the button. The page's address must be https (browsers only give the camera to those).
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { decodeFrame, loadReader, productCode } from '../../lib/barcode';
import type { Section } from '../../shops';
import { Icon, layerHost } from '../../ui/components';
import { addScanned, scanBlocked, scanEnv, scanSaid } from './scan';

const BLACK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

function cameraWords(e: unknown): string {
  const name = e instanceof DOMException ? e.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return "The camera wasn't allowed. Allow the camera for this page in your browser's settings and try again, or type the number below.";
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return "There's no camera here. Type the barcode number below.";
  if (name === 'NotReadableError') return 'Another app is using the camera. Close it and try again, or type the number below.';
  return "The camera didn't start. Type the barcode number below.";
}

/** The scanner over the page; gives back the product code read (or typed), or undefined when closed. */
export function WebScanner({ title, onDone }: { title: string; onDone: (code: string | undefined) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const doneRef = useRef(false);
  const [live, setLive] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [typed, setTyped] = useState('');

  const finish = (code: string | undefined) => {
    if (doneRef.current) return;
    doneRef.current = true;
    onDone(code);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && finish(undefined);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let stream: MediaStream | undefined;
    let timer: number | undefined;
    let stopped = false;
    let busy = false;
    let lastOdd = '';
    void loadReader();
    const tick = async () => {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (stopped || !video || !canvas) return;
      if (!busy && video.readyState >= 2 && video.videoWidth) {
        busy = true;
        try {
          const scale = Math.min(1, 1000 / video.videoWidth);
          canvas.width = Math.round(video.videoWidth * scale);
          canvas.height = Math.round(video.videoHeight * scale);
          const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const text = await decodeFrame(ctx.getImageData(0, 0, canvas.width, canvas.height));
          if (text) {
            const code = productCode(text);
            if (code) {
              navigator.vibrate?.(60);
              return finish(code);
            }
            if (text !== lastOdd) {
              lastOdd = text;
              setNotice("That code isn't a product barcode. Try the pack's barcode instead.");
            }
          }
        } catch {
          // a frame that didn't decode: try the next one
        } finally {
          busy = false;
        }
      }
      timer = window.setTimeout(() => void tick(), 120);
    };
    (async () => {
      const blocked = scanBlocked(scanEnv());
      if (blocked) return setError(blocked);
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        });
        if (stopped) return stream.getTracks().forEach((t) => t.stop());
        const video = videoRef.current!;
        video.srcObject = stream;
        await video.play().catch(() => undefined);
        void tick();
      } catch (e) {
        setError(cameraWords(e));
      }
    })();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return createPortal(
    <div className="scanner pwa-scanner" role="dialog" aria-modal="true" aria-label={title}>
      {/* playsInline and muted: iPhones only show a camera inside the page with both. */}
      <video ref={videoRef} playsInline muted autoPlay poster={BLACK} className={`scanner-video${live ? ' live' : ''}`} onPlaying={() => setLive(true)} />
      <canvas ref={canvasRef} hidden />
      <div className="scanner-top">
        <button className="icon-btn dark" aria-label="Close the scanner" onClick={() => finish(undefined)}>
          <Icon name="close" size={20} />
        </button>
        <span className="scanner-title">{title}</span>
        <span style={{ width: 44 }} />
      </div>
      <div className="scanner-frame" aria-hidden="true" />
      <div className="scanner-bottom">
        <p className={`scanner-msg${notice ? ' warn' : ''}`} role="status">
          {notice ?? error ?? (live ? 'Line the barcode up inside the box.' : 'Starting the camera…')}
        </p>
        <form
          style={{ display: 'flex', gap: 8 }}
          onSubmit={(e) => {
            e.preventDefault();
            const code = productCode(typed.replace(/\s+/g, ''));
            if (code) finish(code);
            else setNotice("That doesn't look like a barcode number. They're 8, 12, 13 or 14 digits.");
          }}
        >
          <input
            className="input"
            inputMode="numeric"
            placeholder="Barcode number"
            aria-label="Type the barcode number"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
          <button className="btn primary" type="submit" disabled={!typed.trim()}>
            Use
          </button>
        </form>
      </div>
    </div>,
    layerHost(),
  );
}

/**
 * A Scan button: opens the scanner and puts what it reads on the Shopping list. Where the camera
 * can't be used (not https), pressing it says why instead of asking for the camera.
 */
export function ScanButton({
  section,
  onSaid,
  className = 'btn',
  label,
}: {
  section: Section;
  /** What to tell the person afterwards (a toast). */
  onSaid: (text: string) => void;
  className?: string;
  /** Words on the button (undefined: just the icon). */
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const blocked = scanBlocked(scanEnv());
  return (
    <>
      <button
        type="button"
        className={className}
        aria-label={label ? undefined : 'Scan a barcode to add'}
        title={blocked ?? 'Scan a barcode to add'}
        onClick={() => (blocked ? onSaid(blocked) : setOpen(true))}
      >
        <Icon name="scan" size={20} />
        {label && <span>{label}</span>}
      </button>
      {open && (
        <WebScanner
          title="Scan to add to your Shopping list"
          onDone={(code) => {
            setOpen(false);
            if (code) void addScanned(code, section).then((r) => onSaid(scanSaid(r)));
          }}
        />
      )}
    </>
  );
}
