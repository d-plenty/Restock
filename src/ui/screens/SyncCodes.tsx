// 0.15.0: phone sharing's codes and the Add a phone sheet (moved out of Sync.tsx, which had grown past
// 2,000 lines): the QR code, the code as text, the countdown, and what the new phone shares.
import { useEffect, useState } from 'react';
import { getSettings, updateSettings } from '../../lib/db';
import { SECTIONS, sectionOn, type Section } from '../../shops';
import { RestockNative } from '../../lib/sql/native';
import { syncInfo, type SyncInfo } from '../../lib/sync';
import { useLive } from '../../lib/useLive';
import { Icon, LoadingBar, Sheet, More } from '../components';
import { useNav } from '../nav';
import { TabsPicker } from './Sync';

/**
 * A QR code as an SVG that scales to any size: one square per module, with the white border
 * scanners need (0.8.2: the zxing picture had a fixed size and was cut off when stretched).
 */
export function qrSvg(symbol: { data: ArrayLike<number>; width: number; height: number }): string {
  const q = 4;
  let d = '';
  for (let y = 0; y < symbol.height; y++)
    for (let x = 0; x < symbol.width; x++) if (symbol.data[y * symbol.width + x] < 128) d += `M${x + q} ${y + q}h1v1h-1z`;
  const w = symbol.width + q * 2;
  const h = symbol.height + q * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="100%" height="100%" shape-rendering="crispEdges"><rect width="${w}" height="${h}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

/** The pairing code as a QR code, drawn on the phone (zxing, bundled; nothing is sent anywhere). */
export function PairingQr({ code, label = 'Pairing QR code' }: { code: string; label?: string }) {
  const [svg, setSvg] = useState<string>();
  useEffect(() => {
    let alive = true;
    void (async () => {
      const [mod, { default: wasmUrl }] = await Promise.all([import('zxing-wasm/writer'), import('zxing-wasm/writer/zxing_writer.wasm?url')]);
      mod.prepareZXingModule({ overrides: { locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? wasmUrl : prefix + path) } });
      const r = await mod.writeBarcode(code, { format: 'QRCode', options: 'ecLevel=M' });
      if (alive && r.symbol?.width) setSvg(qrSvg(r.symbol));
    })().catch((e) => console.error('qr', e));
    return () => {
      alive = false;
    };
  }, [code]);
  return (
    <div className="sync-qr" role="img" aria-label={label}>
      {svg ? <span dangerouslySetInnerHTML={{ __html: svg }} /> : <LoadingBar seconds={3} />}
    </div>
  );
}

/**
 * The pairing code as text, for when the camera won't read the QR code (0.8.1): send it to the
 * other phone in a message and paste it into Join a household → "Or paste the code".
 */
export function CodeText({ code }: { code: string }) {
  const nav = useNav();
  const share = async () => {
    try {
      const { Share } = await import('@capacitor/share');
      await Share.share({ title: 'Restock sync code', text: code });
    } catch {
      // cancelled
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      nav.toast('Code copied');
    } catch {
      void share();
    }
  };
  return (
    <details className="sync-code">
      <summary className="small">Can't scan it? Send the code instead</summary>
      <p className="small">Send this code to the other phone, then paste it into Join a household there. Keep it private.{' '}<More title="Sending the code"><p>Send this to the other phone (a text message to yourself is fine), copy it, then on that phone tap Join a household and paste it into "Or
        paste the code". Keep it private, like a Wi-Fi password.</p></More></p>
      <code className="sync-code-text">{code}</code>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn small" onClick={() => void copy()}>
          Copy
        </button>
        <button className="btn small" onClick={() => void share()}>
          <Icon name="share" size={16} /> Send
        </button>
      </div>
    </details>
  );
}

/** Yes / No buttons for "share my loyalty cards?" (asked when pairing). */
export function CardsQuestion({ onAnswer }: { onAnswer: (share: boolean) => void }) {
  return (
    <div className="card" style={{ gap: 10 }}>
      <strong>Share your loyalty cards with the household's other phones?</strong>
      <span className="small">Your Flybuys and Everyday Rewards numbers would be copied to them.{' '}<More title="Sharing loyalty cards"><p>Your Flybuys and Everyday Rewards numbers would be copied to them, so member prices count on every phone and anyone can show the card at the
        checkout. You can change this any time on this screen.</p></More></span>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn primary" style={{ flex: 1 }} onClick={() => onAnswer(true)}>
          Yes, share them
        </button>
        <button className="btn" style={{ flex: 1 }} onClick={() => onAnswer(false)}>
          No, keep them here
        </button>
      </div>
    </div>
  );
}

/** "9:41 left" until a code runs out. */
function useCountdown(until: number | undefined) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!until) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [until]);
  if (!until) return undefined;
  const left = Math.max(0, Math.round((until - now) / 1000));
  return { left, text: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` };
}

/**
 * Start a household, or (owner) add a phone: a new one-time code each time, working once and
 * for 10 minutes. Closing the sheet closes the code.
 */
export function InviteSheet({ info, onClose }: { info: SyncInfo; onClose: () => void }) {
  const settings = useLive(getSettings, []);
  const [household, setHousehold] = useState<string>();
  const [code, setCode] = useState<string>();
  const [until, setUntil] = useState<number>();
  const [error, setError] = useState<string>();
  const [known, setKnown] = useState<string[]>(info.members?.map((m) => m.device) ?? []);
  const [joined, setJoined] = useState<string>();
  const [tabs, setTabs] = useState<Section[]>();
  const name = household ?? info.household ?? settings?.household.name ?? 'Our house';
  const left = useCountdown(until);
  // Starting a household: share groceries, and Keg and Pharmacy if this phone uses them.
  const shared = tabs ?? (settings ? SECTIONS.filter((t) => t === 'pantry' || sectionOn(settings, t)) : ['pantry' as Section]);

  const make = async (shareCards: boolean) => {
    setError(undefined);
    try {
      const r = await RestockNative.syncInvite({ household: name, shareCards, tabs: shared });
      if (!info.paired) await updateSettings({ household: { name } });
      setCode(r.code);
      setUntil(Date.now() + r.expiresInMs);
      setJoined(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  // Already in a household: the card question was answered then.
  useEffect(() => {
    if (info.paired) void make(!!info.shareCards);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Notice when the other phone has joined: a phone that wasn't in the household before, or one
  // rejoining whose old entry was still there (it has just synced).
  useEffect(() => {
    if (!code) return;
    const started = new Date().toISOString();
    const t = setInterval(() => {
      void syncInfo().then((i) => {
        const fresh = i.members?.find((m) => !m.me && !known.includes(m.device));
        const back = i.members?.find((m) => !m.me && (i.peers?.find((p) => p.device === m.device)?.syncedAt ?? '') > started && !fresh);
        const who = fresh ?? (i.lastSyncAt && i.lastSyncAt > started ? back : undefined);
        if (who) {
          setJoined(who.name);
          setKnown(i.members?.map((m) => m.device) ?? []);
          setCode(undefined);
        }
      });
    }, 2000);
    return () => clearInterval(t);
  }, [code, known]);
  const close = () => {
    void RestockNative.syncCloseInvite().catch(() => undefined);
    onClose();
  };
  const expired = left && left.left === 0;

  return (
    <Sheet title={info.paired ? 'Add a phone' : 'Start a household'} onClose={close}>
      {!code && !joined && !info.paired && (
        <>
          <label className="field">
            <span>Household name</span>
            <input className="input" value={name} onChange={(e) => setHousehold(e.target.value)} />
          </label>
          <div className="eyebrow">What the household shares</div>
          <TabsPicker offered={SECTIONS} value={shared} onChange={setTabs} />
          <p className="small" style={{ marginTop: -4 }}>Each phone that joins picks from these. You can change it later.</p>
          {shared.length ? <CardsQuestion onAnswer={(share) => void make(share)} /> : <div className="banner amber">Pick at least one thing to share.</div>}
        </>
      )}
      {error && <div className="banner amber">{error}</div>}
      {joined && (
        <>
          <div className="banner green" role="status">
            <strong>{joined} joined</strong>
            <span style={{ fontSize: 13 }}>The phones are syncing. That code can't be used again.</span>
          </div>
          <button className="btn block" onClick={() => void make(!!info.shareCards)}>
            Add another phone
          </button>
          <button className="btn block primary" onClick={close}>
            Done
          </button>
        </>
      )}
      {code && !joined && (
        <>
          {expired ? (
            <div className="banner amber">
              <strong>This code has run out</strong>
              <button className="btn small" style={{ alignSelf: 'flex-start' }} onClick={() => void make(!!info.shareCards)}>
                Make a new code
              </button>
            </div>
          ) : (
            <PairingQr code={code} />
          )}
          {!expired && left && (
            <span className="small" role="status" style={{ textAlign: 'center' }}>
              Works once, for the next {left.text}. Waiting for the other phone…
            </span>
          )}
          {!expired && <CodeText code={code} />}
          <ol className="small" style={{ margin: 0, paddingLeft: 18 }}>
            <li>Put both phones on the same Wi-Fi, and keep this screen open.</li>
            <li>On the other phone (Restock 0.8.5 or newer), tap Join your household on the first screen, or Settings → Sync and backups → Join a household.</li>
            {/* 0.14.0: an iPhone or iPad joins the same way, from its own screen. */}
            <li>On an iPhone or iPad (Restock 0.14.0 or newer): Settings → Sync and backups → Sync with an Android phone → Join with a code. It syncs while Restock is open on it.</li>
            <li>Scan this code.</li>
          </ol>
          <button className="btn block" onClick={close}>
            Cancel
          </button>
        </>
      )}
    </Sheet>
  );
}
