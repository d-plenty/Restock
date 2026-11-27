// The Restock logo (0.18.3: its own file, so the server's web page can draw it and the opening
// animation without the rest of components.tsx).
import { useId, type ReactNode } from 'react';
import { ICON_PAINT, type IconPaint } from '../lib/looks';

/** The Restock logo: a basket with a falling price line. */
export function Logo({ size = 56 }: { size?: number }) {
  // Same drawing as the launcher icon (tools/icons/make-icons.cjs). 0.16.0: a soft shine, the basket's
  // weave, and a gold price tag on the handle. `useId`: several logos on one page each keep their own colours.
  const id = useId().replace(/:/g, '');
  return (
    <svg width={size} height={size} viewBox="18 18 72 72" role="img" aria-label="Restock" style={{ overflow: 'visible' }}>
      <LogoDrawing id={id} />
    </svg>
  );
}

/**
 * The logo's parts (in its 108-unit drawing, the tile at 18…90), with class names the opening
 * animation moves (Opening.tsx). `extra`: drawn on top, in the basket's space (a holiday's hat);
 * `before` and `after`: behind and in front of the tile, in the tile's space (ears, a pumpkin).
 */
const GREEN_PAINT = ICON_PAINT.green;
export function LogoDrawing({ id, extra, before, after, paint }: { id: string; extra?: ReactNode; before?: ReactNode; after?: ReactNode; /** 0.17.0: another app icon colour (looks.ts ICON_PAINT). */ paint?: IconPaint }) {
  const p = paint ?? GREEN_PAINT;
  return (
    <>
      <defs>
        <linearGradient id={`${id}-g`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={p.bg[0]} />
          <stop offset="1" stopColor={p.bg[1]} />
        </linearGradient>
        <linearGradient id={`${id}-s`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.22" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
      </defs>
      {before}
      <g className="lg-tile">
        <rect x="18" y="18" width="72" height="72" rx="16" fill={`url(#${id}-g)`} />
        <rect x="19.5" y="19.5" width="69" height="30" rx="14.5" fill={`url(#${id}-s)`} />
      </g>
      <g transform="translate(54 54.5) scale(0.8) translate(-54 -53.5)">
        <path className="lg-handle" pathLength={1} d="M38.5,47 C38.5,27.5 69.5,27.5 69.5,47" fill="none" stroke={p.basket} strokeWidth="7" strokeLinecap="round" />
        <g className="lg-basket">
          <path d="M25.6,45 H82.4 Q86.6,45 85.6,49.1 L78.7,75.4 Q77.7,79.4 73.6,79.4 H34.4 Q30.3,79.4 29.3,75.4 L22.4,49.1 Q21.4,45 25.6,45 Z" fill={p.basket} />
          <path d="M24.6,52.6 H83.4" stroke={p.rim} strokeWidth="2.4" />
          <path d="M38,56 L40,76 M49.3,56 L49.8,76 M58.7,56 L58.2,76 M70,56 L68,76" stroke={p.weave} strokeWidth="2" strokeLinecap="round" />
        </g>
        <path className="lg-line" pathLength={1} d="M35,58.5 L45.5,68 L54.5,61.2 L68,72.6" fill="none" stroke={p.line} strokeWidth="5.8" strokeLinecap="round" strokeLinejoin="round" />
        <path className="lg-line lg-arrow" pathLength={1} d="M58.6,73.2 H68.6 V63.2" fill="none" stroke={p.line} strokeWidth="5.8" strokeLinecap="round" strokeLinejoin="round" />
        <g className="lg-tag">
          <path d="M66,32 L70.5,34.6" stroke={p.basket} strokeWidth="1.4" />
          <g transform="rotate(28 76 39)">
            <path d="M70.5,34.5 H82 Q84,34.5 84,36.5 V41.5 Q84,43.5 82,43.5 H70.5 L67,39 Z" fill={p.tag ?? '#FFCD00'} />
            <circle cx="71" cy="39" r="1.2" fill="#0E4A2B" />
            <path d="M80.3,37 C79.7,36.3 79,36.1 78.3,36.1 C77.1,36.1 76.5,36.8 76.6,37.6 C76.7,38.4 77.5,38.7 78.5,39 C79.6,39.3 80.4,39.8 80.4,40.8 C80.4,41.8 79.5,42.4 78.4,42.4 C77.6,42.4 76.9,42.1 76.4,41.4" fill="none" stroke="#012169" strokeWidth="1.35" strokeLinecap="round" />
            <path d="M78.45,35 V43.5" stroke="#012169" strokeWidth="1.1" strokeLinecap="round" />
          </g>
        </g>
        {extra}
      </g>
      {after}
    </>
  );
}

