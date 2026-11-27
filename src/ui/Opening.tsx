// 0.16.0: the opening animation. It plays once each time Restock starts from closed (not when it
// comes back from the background: the app is still running then), about two and a half seconds,
// and a tap ends it early. With Less motion on (Settings → Accessibility, or the phone's own Reduce
// motion) it's a still picture for the same time. Off altogether with Settings → Look and colours →
// Opening animation (look.opening); Settings can also play any of them (OpeningPreview.tsx). On a holiday (lib/holiday.ts) it's that holiday's: Christmas, New Year, Australia
// Day, Easter or Halloween, each with a day and a night look (light and dark mode). The logo is the
// app's (components.tsx LogoDrawing); its parts move here (opening.css). The big holiday pictures
// were drawn first for Plenty Flow (openingScenes/), and each loads only when it plays.
import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { Holiday } from '../lib/holiday';
import { LogoDrawing } from './Logo';
import './opening.css';

/** How long it shows before it fades (ms). */
/** 0.18.0: how long the usual opening shows before it fades (2.5 seconds in all, the fade included). */
export const OPENING_MS = 2150;
/** And a holiday's (3.5 seconds in all): there's more to look at. */
export const EVENT_MS = 3150;
/** The fade at the end (ms). */
export const FADE_MS = 350;

let played = false;
/** It plays once per start of the app (this page load), never again until Restock is started again. */
export const openingPlayed = () => played;
/** For the tests. */
export const resetOpening = () => void (played = false);

/** Less motion: the app's own setting, or the phone's. */
export const lessMotion = (setting: boolean): boolean => setting || (typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

const SUB: Record<Holiday | 'none', string> = {
  none: 'Half price? Prove it.',
  christmas: 'Merry Christmas',
  newyear: 'Happy New Year',
  australia: 'Happy Australia Day',
  easter: 'Happy Easter',
  halloween: 'Happy Halloween',
};

/**
 * Day or night: the light look in light mode and the dark look in dark mode, so it never blinds
 * anyone at night or looks dull in the day.
 */
export type OpeningLook = 'day' | 'night';

/** A picture drawn as SVG markup with its own animations (openingScenes/*.ts). */
interface Picture {
  css: string;
  svg: string;
  /** The holiday line's pill: its background and text colour. */
  pill: [string, string] | null;
}

export function Opening({
  holiday,
  onDone,
  look = 'night',
  still = false,
  thumb = false,
}: {
  holiday?: Holiday;
  onDone?: () => void;
  look?: OpeningLook;
  still?: boolean;
  /** 0.17.0: a small still picture of it (Settings → See the animations), not the opening itself. */
  thumb?: boolean;
}) {
  const id = useId().replace(/:/g, '');
  const [leaving, setLeaving] = useState(false);
  const done = useRef(onDone ?? (() => undefined));
  useEffect(() => {
    done.current = onDone ?? (() => undefined);
  });
  useEffect(() => {
    if (thumb) return;
    played = true;
    const t = setTimeout(() => done.current(), (holiday ? EVENT_MS : OPENING_MS) + FADE_MS);
    return () => clearTimeout(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const skip = () => {
    if (leaving) return;
    setLeaving(true);
    setTimeout(() => done.current(), 250);
  };
  const h = holiday ?? 'none';
  const set = SCENES[h];
  const key: OpeningLook = set[look] ? look : 'night';
  const scene = set[key] ?? {};
  const pictureKey = scene.picture ? `${h}-${key}` : '';
  const [picture, setPicture] = useState<{ key: string; p: Picture }>();
  useEffect(() => {
    if (!scene.picture) return;
    let on = true;
    void scene.picture().then((p) => on && setPicture({ key: pictureKey, p }));
    return () => {
      on = false;
    };
  }, [pictureKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const pic = picture?.key === pictureKey ? picture.p : undefined;
  const easter = holiday === 'easter';
  // Light skies have navy words; dark ones white (opening.css .op-lite).
  const lite = LITE.has(`${h}-${key}`);
  const Tag = thumb ? 'span' : 'button';
  return (
    <Tag
      {...(thumb ? { 'aria-hidden': true } : { type: 'button' as const, onClick: skip, 'aria-label': 'Restock is starting' })}
      className={`opening op-${h}${h !== 'none' ? ' op-event' : ''} op-${key}${lite ? ' op-lite' : ''}${scene.picture ? ' op-big' : ''}${still || thumb ? ' op-still' : ''}${thumb ? ' op-thumb' : ''}${leaving ? ' op-leaving' : ''}`}
    >
      {scene.behind}
      {pic && (
        <div className={`op-picture op-pf-${scene.pictureId}`} aria-hidden="true">
          <style>{pic.css}</style>
          <svg
            viewBox="0 0 390 844"
            preserveAspectRatio="xMidYMax slice"
            ref={(el) => {
              // Less motion: the picture's own SVG animations stop where they'd be, too.
              if (el && (still || thumb)) {
                el.setCurrentTime?.(2.2);
                el.pauseAnimations?.();
              }
            }}
            dangerouslySetInnerHTML={{ __html: pic.svg }}
          />
        </div>
      )}
      <svg className="op-logo" viewBox={easter ? '18 -10 72 100' : '18 18 72 72'} aria-hidden="true">
        <LogoDrawing id={id} before={scene.logoBefore} extra={scene.logoExtra} after={scene.logoAfter} />
      </svg>
      {!thumb && (
      <div className="op-words">
        <div className="op-word">Restock</div>
        <div className="op-sub" style={pic?.pill ? style({ background: pic.pill[0], color: pic.pill[1] }) : undefined}>
          {SUB[h]}
        </div>
      </div>
      )}
    </Tag>
  );
}

// ---------- the scenes ----------

interface Scene {
  /** Behind everything (the sky, the hill, the eggs). */
  behind?: ReactNode;
  /** A holiday's big picture (openingScenes/), loaded when it plays. */
  picture?: () => Promise<Picture>;
  pictureId?: string;
  /** In the logo, behind the tile / on the basket / in front of the tile. */
  logoBefore?: ReactNode;
  logoExtra?: ReactNode;
  logoAfter?: ReactNode;
}

const style = (s: CSSProperties) => s;


const SANTA_HAT = (
  <g className="op-hat">
    <path d="M33,36 Q40,14 56,22 Q52,26 52,33 Z" fill="#C8102E" />
    <path d="M31.5,37.5 Q42,31 53.5,34" fill="none" stroke="#ffffff" strokeWidth="5" strokeLinecap="round" />
    <circle cx="57" cy="22" r="3.2" fill="#ffffff" />
  </g>
);

const PUMPKIN = (
  <g className="op-pumpkin">
    <path d="M86,72 q1,-4 4,-5" stroke="#3a6b2a" strokeWidth="2" fill="none" strokeLinecap="round" />
    <ellipse cx="80.5" cy="84" rx="6" ry="9" fill="#e36a12" />
    <ellipse cx="91.5" cy="84" rx="6" ry="9" fill="#e36a12" />
    <ellipse cx="86" cy="84" rx="7" ry="9.6" fill="#ff8a1c" />
    <g className="op-face" fill="#ffe28a">
      <path d="M81,81 l3,-3 l3,3 z" />
      <path d="M86,81 l3,-3 l3,3 z" />
      <path d="M80.5,86 q5.5,5 11,0 q-2,1.5 -3,0 q-1.2,1.6 -2.5,0 q-1.3,1.6 -2.5,0 q-1.2,1.6 -3,0 z" />
    </g>
  </g>
);

/** New Year: a party hat on the logo. */
const PARTY_HAT = (
  <g className="op-hat">
    <path d="M36,36 L47,10 L57,34 Z" fill="#FFD54F" />
    <path d="M40,27 L53,25 M43,19 L51,18" stroke="#C62828" strokeWidth="2.4" />
    <circle cx="47" cy="10" r="3.4" fill="#C62828" />
  </g>
);

function Stars({ n = 16, top = 300 }: { n?: number; top?: number }) {
  return (
    <>
      {Array.from({ length: n }, (_, i) => (
        <span key={i} className="op-star" style={style({ left: `${((i * 67 + 13) % 380) / 3.9}%`, top: `${((i * 41 + 20) % top) / 8.44}%`, animationDelay: `${((i * 0.37) % 1.8).toFixed(2)}s` })} />
      ))}
    </>
  );
}

const EGGS = [
  ['#f6b8c8', '#e07a98', -8],
  ['#bfe3f5', '#5fa8d3', 6],
  ['#ffe28a', '#e0a800', -4],
  ['#c9e7b0', '#6fae3f', 10],
  ['#d9c7f2', '#9a7bd1', -6],
] as const;
const EGG = 'M20,2 C31,2 38,20 38,32 C38,43 30,50 20,50 C10,50 2,43 2,32 C2,20 9,2 20,2 Z';
function Eggs() {
  return (
    <div className="op-eggs">
      {EGGS.map(([fill, band, turn], i) => (
        <svg key={fill} className="op-egg" width="40" height="52" viewBox="0 0 40 52" style={style({ animationDelay: `${0.6 + i * 0.12}s`, rotate: `${turn}deg` })}>
          <defs>
            <clipPath id={`op-egg-${i}`}>
              <path d={EGG} />
            </clipPath>
          </defs>
          <path d={EGG} fill={fill} />
          <g clipPath={`url(#op-egg-${i})`}>
            <path d="M0,24 q5,-5 10,0 t10,0 t10,0 t10,0" stroke="#ffffff" strokeWidth="3.2" fill="none" />
            <rect x="0" y="34" width="40" height="5" fill={band} />
          </g>
        </svg>
      ))}
    </div>
  );
}

const EARS = (
  <g clipPath="url(#op-above)">
    <defs>
      <clipPath id="op-above">
        <rect x="0" y="-40" width="120" height="70" />
      </clipPath>
    </defs>
    <g className="op-ears">
      <g transform="rotate(-12 42 24)">
        <ellipse cx="42" cy="6" rx="6.5" ry="18" fill="#F6F1E4" />
        <ellipse cx="42" cy="8" rx="3.2" ry="12" fill="#f6b8c8" />
      </g>
      <g className="op-ear-r">
        <g transform="rotate(12 66 24)">
          <ellipse cx="66" cy="6" rx="6.5" ry="18" fill="#F6F1E4" />
          <ellipse cx="66" cy="8" rx="3.2" ry="12" fill="#f6b8c8" />
        </g>
      </g>
    </g>
  </g>
);

/** Easter in the day: sky over a hill, the eggs, ears behind the logo. */
const easter: Scene = {
  behind: (
    <div className="op-layer" aria-hidden="true">
      <div className="op-hill" />
      <Eggs />
    </div>
  ),
  logoBefore: EARS,
};

/** Easter at night: twilight, with fireflies over the grass and the eggs aglow. */
const easterNight: Scene = {
  behind: (
    <div className="op-layer" aria-hidden="true">
      <Stars n={8} top={200} />
      <div className="op-hill" />
      {Array.from({ length: 14 }, (_, i) => (
        <span key={i} className="op-firefly" style={style({ left: `${(i * 53 + 9) % 96}%`, top: `${58 + ((i * 29) % 24)}%`, animationDelay: `${((i * 0.43) % 2.2).toFixed(2)}s` })} />
      ))}
      <Eggs />
    </div>
  ),
  logoBefore: EARS,
};

const pf = (id: string, load: () => Promise<Picture>, rest: Partial<Scene> = {}): Scene => ({ picture: load, pictureId: id, ...rest });
const christmasDay = pf('christmasDay', () => import('./openingScenes/christmasDay'), { logoExtra: SANTA_HAT });
const christmasNight = pf('christmasNight', () => import('./openingScenes/christmasNight'), { logoExtra: SANTA_HAT });
const newYearDay = pf('newYearDay', () => import('./openingScenes/newYearDay'), { logoExtra: PARTY_HAT });
const newYearNight = pf('newYearNight', () => import('./openingScenes/newYearNight'), { logoExtra: PARTY_HAT });
const australiaDay = pf('australiaDay', () => import('./openingScenes/australiaDay'));
const australiaNight = pf('australiaNight', () => import('./openingScenes/australiaNight'));
const halloweenDay = pf('halloweenDay', () => import('./openingScenes/halloweenDay'), { logoAfter: PUMPKIN });
const halloweenNight = pf('halloweenNight', () => import('./openingScenes/halloweenNight'), { logoAfter: PUMPKIN });

type SceneSet = { day?: Scene; night?: Scene };
const SCENES: Record<Holiday | 'none', SceneSet> = {
  // The usual one is the same navy, day and night.
  none: { night: {} },
  christmas: { day: christmasDay, night: christmasNight },
  newyear: { day: newYearDay, night: newYearNight },
  australia: { day: australiaDay, night: australiaNight },
  easter: { day: easter, night: easterNight },
  halloween: { day: halloweenDay, night: halloweenNight },
};
/** The scenes with a light sky (navy words). */
const LITE = new Set(['easter-day']);
