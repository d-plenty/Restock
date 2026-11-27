// 0.18.1: Restock's own colour wheel, the same on every phone, tablet and the web page (it was the
// phone's own colour picker, a different one on each). Drag on the wheel for the colour (around)
// and how strong it is (out from the middle), the slider for how light or dark, or type a code
// like #2e7d32. Nothing changes until Use this colour.
import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { textOn } from '../lib/theme';
import { Sheet } from './components';

type Hsv = { h: number; s: number; v: number };

/** "#rrggbb" to hue (0 to 360), saturation and value (0 to 1). Anything else is the default green. */
export function hexToHsv(hex: string): Hsv {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m ? parseInt(m[1], 16) : 0x00843d;
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((x) => x / 255);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s: max ? d / max : 0, v: max };
}

export function hsvToHex({ h, s, v }: Hsv): string {
  const f = (k: number) => {
    const x = (k + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(x, 4 - x, 1));
  };
  return '#' + [f(5), f(3), f(1)].map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('');
}

const clamp = (x: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));

export function ColourWheel({ title, value, onPick, onClose }: { title: string; value: string; onPick: (hex: string) => void; onClose: () => void }) {
  const [hsv, setHsvOnly] = useState<Hsv>(() => hexToHsv(value));
  const hex = hsvToHex(hsv);
  // What's typed in the code box while it's being typed (otherwise the box shows the colour's code).
  const [typing, setTyping] = useState<string>();
  const typed = typing ?? hex;
  const setHsv = (f: (o: Hsv) => Hsv) => {
    setTyping(undefined);
    setHsvOnly(f);
  };
  const wheel = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const pickAt = (x: number, y: number) => {
    const el = wheel.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const dx = x - (r.left + r.width / 2);
    const dy = y - (r.top + r.height / 2);
    const h = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
    const s = clamp(Math.hypot(dx, dy) / (r.width / 2));
    // Picking on the wheel at "black" would show nothing: it comes up to full brightness.
    setHsv((o) => ({ h, s, v: o.v < 0.15 ? 1 : o.v }));
  };
  const down = (e: PointerEvent<HTMLDivElement>) => {
    dragging.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    pickAt(e.clientX, e.clientY);
  };
  const move = (e: PointerEvent<HTMLDivElement>) => dragging.current && pickAt(e.clientX, e.clientY);
  const up = () => (dragging.current = false);
  // Arrows: left and right go round the wheel, up and down in and out.
  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 15 : 5;
    const k = e.key;
    if (k === 'ArrowLeft' || k === 'ArrowRight') setHsv((o) => ({ ...o, h: (o.h + (k === 'ArrowRight' ? step : -step) + 360) % 360 }));
    else if (k === 'ArrowUp' || k === 'ArrowDown') setHsv((o) => ({ ...o, s: clamp(o.s + (k === 'ArrowUp' ? 0.05 : -0.05)) }));
    else return;
    e.preventDefault();
  };
  const angle = (hsv.h * Math.PI) / 180;
  const knob = { left: `${50 + Math.sin(angle) * hsv.s * 50}%`, top: `${50 - Math.cos(angle) * hsv.s * 50}%` };
  const typedOk = /^#?[0-9a-f]{6}$/i.test(typed.trim());

  return (
    <Sheet title={title} onClose={onClose}>
      <div className="cw">
        <div
          ref={wheel}
          className="cw-wheel"
          role="slider"
          tabIndex={0}
          aria-label="Colour wheel: left and right for the colour, up and down for how strong"
          aria-valuemin={0}
          aria-valuemax={360}
          aria-valuenow={Math.round(hsv.h)}
          aria-valuetext={hex}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          onKeyDown={keys}
        >
          <span className="cw-dim" style={{ opacity: 1 - hsv.v }} aria-hidden />
          <span className="cw-knob" style={{ ...knob, background: hex }} aria-hidden />
        </div>
        <label className="field cw-light">
          <span>Light or dark</span>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(hsv.v * 100)}
            style={{ background: `linear-gradient(90deg, #000, ${hsvToHex({ ...hsv, v: 1 })})` }}
            onChange={(e) => setHsv((o) => ({ ...o, v: Number(e.target.value) / 100 }))}
            aria-valuetext={`${Math.round(hsv.v * 100)}% light`}
          />
        </label>
        <div className="cw-row">
          <span className="cw-preview" style={{ background: hex, color: textOn(hex) }} aria-hidden>
            Aa
          </span>
          <label className="field grow">
            <span>Colour code</span>
            <input
              className="input"
              value={typed}
              maxLength={7}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={!typedOk}
              onChange={(e) => {
                const t = e.target.value;
                setTyping(t);
                if (/^#?[0-9a-f]{6}$/i.test(t.trim())) setHsvOnly(hexToHsv(t.trim().startsWith('#') ? t.trim() : `#${t.trim()}`));
              }}
            />
          </label>
        </div>
        <div className="cw-btns">
          <button className="btn" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            type="button"
            onClick={() => {
              onPick(hex);
              onClose();
            }}
          >
            Use this colour
          </button>
        </div>
      </div>
    </Sheet>
  );
}
