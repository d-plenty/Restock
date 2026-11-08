import { Capacitor } from '@capacitor/core';
import { useEffect, useRef, useState } from 'react';

/** 1×1 black GIF. */
const BLACK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
import {
  decodeFrame,
  decodePhoto,
  loadReader,
  productCode,
  setScannerListener,
  type ScanKind,
  type ScanOutcome,
  type ScanRequest,
} from '../lib/barcode';
import { Icon } from './components';

/** Mounted once in App; shows the camera scanner whenever scanBarcode() is called. */
export function ScannerHost() {
  const [req, setReq] = useState<ScanRequest>();
  useEffect(() => {
    setScannerListener(setReq);
    return () => setScannerListener(undefined);
  }, []);
  if (!req) return null;
  return <Scanner title={req.title} kind={req.kind} onDone={req.resolve} />;
}

function Scanner({ title, kind, onDone }: { title: string; kind?: ScanKind; onDone: (o: ScanOutcome) => void }) {
  // A product barcode, unless this scan is for something else (0.8.0: the sync pairing code).
  const read = (text: string) => (kind ? kind.accept(text) : productCode(text));
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const trackRef = useRef<MediaStreamTrack | undefined>(undefined);
  const [error, setError] = useState<string>();
  const [torch, setTorch] = useState<boolean | undefined>(undefined); // undefined = not supported
  const [typed, setTyped] = useState('');
  const [live, setLive] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [reading, setReading] = useState(false);
  const doneRef = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);
  // A QR code that isn't a product (a website, Wi-Fi details) is ignored for a few seconds.
  const ignoredRef = useRef<{ text: string; until: number }>(undefined);

  const notProduct = (text: string) =>
    kind
      ? kind.wrong
      : /^https?:/i.test(text)
        ? "That QR code is a website link, not a product code. Try the pack's barcode instead."
        : "That code isn't a product barcode. Try the pack's barcode instead.";

  const finish = (o: ScanOutcome) => {
    if (doneRef.current) return;
    doneRef.current = true;
    trackRef.current?.stop();
    onDone(o);
  };

  // Android back button (App sends Escape) closes the scanner.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && finish({ ok: false, reason: 'cancelled' });
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let stream: MediaStream | undefined;
    let timer: number | undefined;
    let busy = false;
    let stopped = false;
    void loadReader(); // start loading the decoder while the camera warms up

    const tick = async () => {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (stopped || !video || !canvas) return;
      if (!busy && video.readyState >= 2 && video.videoWidth) {
        busy = true;
        try {
          // Scale big frames down: faster to decode, still plenty of detail.
          const scale = Math.min(1, 1000 / video.videoWidth);
          canvas.width = Math.round(video.videoWidth * scale);
          canvas.height = Math.round(video.videoHeight * scale);
          const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const text = await decodeFrame(ctx.getImageData(0, 0, canvas.width, canvas.height));
          if (text) {
            const code = read(text);
            if (code) {
              navigator.vibrate?.(60);
              finish({ ok: true, code });
              return;
            }
            const ig = ignoredRef.current;
            if (!ig || ig.text !== text || ig.until < Date.now()) {
              ignoredRef.current = { text, until: Date.now() + 4000 };
              setNotice(notProduct(text));
            }
          }
        } catch (e) {
          console.error('decode failed', e);
        } finally {
          busy = false;
        }
      }
      timer = window.setTimeout(tick, 120);
    };

    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('This device has no camera access.');
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        });
        if (stopped) return stream.getTracks().forEach((t) => t.stop());
        const track = stream.getVideoTracks()[0];
        trackRef.current = track;
        const caps = (track.getCapabilities?.() ?? {}) as MediaTrackCapabilities & { torch?: boolean };
        if (caps.torch) setTorch(false);
        // Ask for continuous focus where the camera supports it.
        await track
          .applyConstraints({
            advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet],
          })
          .catch(() => undefined);
        const video = videoRef.current!;
        video.srcObject = stream;
        await video.play().catch(() => undefined);
        void tick();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!Capacitor.isNativePlatform()) setError('The camera scanner works in the Android app. Type the barcode number below instead.');
        else
          setError(
            /denied|permission|notallowed/i.test(msg)
              ? 'Camera permission was refused. Allow it in Android settings, or type the barcode below.'
              : `Camera unavailable: ${msg}`,
          );
      }
    })();

    return () => {
      stopped = true;
      window.clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleTorch = async () => {
    const t = trackRef.current;
    if (!t || torch === undefined) return;
    try {
      await t.applyConstraints({
        advanced: [{ torch: !torch } as MediaTrackConstraintSet],
      });
      setTorch(!torch);
    } catch {
      setTorch(undefined);
    }
  };

  return (
    <div className="scanner" role="dialog" aria-label={title}>
      {/* A black poster stops Android's grey "play" placeholder showing before the camera starts. */}
      <video
        ref={videoRef}
        playsInline
        muted
        autoPlay
        poster={BLACK}
        className={`scanner-video${live ? ' live' : ''}`}
        onPlaying={() => setLive(true)}
      />
      <canvas ref={canvasRef} hidden />
      <div className="scanner-top">
        <button className="icon-btn dark" aria-label="Close scanner" onClick={() => finish({ ok: false, reason: 'cancelled' })}>
          <Icon name="close" size={20} />
        </button>
        <span className="scanner-title">{title}</span>
        {torch !== undefined ? (
          <button className="icon-btn dark" aria-label={torch ? 'Torch off' : 'Torch on'} aria-pressed={torch} onClick={toggleTorch}>
            <Icon name="torch" size={20} />
          </button>
        ) : (
          <span style={{ width: 44 }} />
        )}
      </div>
      <div className="scanner-frame" aria-hidden="true" />
      <div className="scanner-bottom">
        {notice ? (
          <p className="scanner-msg warn" role="status">
            {notice}
          </p>
        ) : error ? (
          <p className="scanner-msg">{error}</p>
        ) : (
          <p className="scanner-msg">
            {live ? (kind ? 'Line the QR code up inside the box.' : 'Line the barcode or QR code up inside the box.') : 'Starting the camera…'}
          </p>
        )}
        <div style={{ display: 'flex' }}>
          <button className="btn small scanner-photo" disabled={reading} onClick={() => fileRef.current?.click()}>
            <Icon name="image" size={18} /> {reading ? 'Reading the photo…' : 'From photos'}
          </button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (!file) return;
            setReading(true);
            setNotice(undefined);
            try {
              const text = await decodePhoto(file);
              const code = text && read(text);
              if (code) finish({ ok: true, code });
              else setNotice(text ? notProduct(text) : "Couldn't find a barcode in that photo. Try one that's sharp and close up.");
            } catch (err) {
              console.error('photo decode failed', err);
              setNotice("Couldn't read that photo.");
            } finally {
              setReading(false);
            }
          }}
        />
        <form
          style={{ display: 'flex', gap: 8 }}
          onSubmit={(e) => {
            e.preventDefault();
            const code = kind ? typed.trim() : typed.replace(/\s+/g, '');
            if (!code) return;
            const product = read(code);
            if (product) finish({ ok: true, code: product });
            else setNotice(kind ? kind.wrong : "That doesn't look like a barcode number. They're 8, 12, 13 or 14 digits.");
          }}
        >
          <input
            className="input"
            inputMode={kind ? 'text' : 'numeric'}
            placeholder={kind ? kind.typeHint : 'Or type the number'}
            aria-label={kind ? kind.typeHint : 'Type the barcode number'}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
          <button className="btn primary" type="submit" disabled={!typed.trim()}>
            Use
          </button>
        </form>
      </div>
    </div>
  );
}
