// 0.16.0: a little decoration in Home's top bar on a holiday (lib/holiday.ts), and only there:
// Christmas lights, a spider and a cobweb, Easter eggs, a faint Southern Cross. Plus a Santa hat on
// Check now, and bunny ears behind your name. Pictures only: screen readers skip them.
import type { Holiday } from '../lib/holiday';

const BULBS = ['#C8102E', '#FFCD00', '#2BB673', '#ffffff'];
// New Year: confetti scattered over the right of the top bar.
const CONFETTI: [number, number, string, number][] = Array.from({ length: 18 }, (_, i) => [210 + ((i * 47) % 170), 14 + ((i * 31) % 150), ['#FFD54F', '#F06292', '#4FC3F7', '#81C784', '#ffffff'][i % 5], (i * 37) % 180]);

function star(cx: number, cy: number, r: number, n: number): string {
  const inner = r * (n === 7 ? 0.44 : 0.4);
  const pts: string[] = [];
  for (let i = 0; i < n * 2; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / n;
    const rr = i % 2 ? inner : r;
    pts.push(`${(cx + rr * Math.cos(a)).toFixed(2)},${(cy + rr * Math.sin(a)).toFixed(2)}`);
  }
  return pts.join(' ');
}

/** Behind the top bar's words. */
export function HolidayDecor({ holiday }: { holiday?: Holiday }) {
  if (!holiday) return null;
  return (
    <div className={`holiday-decor hd-${holiday}`} aria-hidden="true">
      {holiday === 'christmas' && (
        <svg className="hd-lights" viewBox="0 0 390 40" preserveAspectRatio="none">
          <path d="M-10,4 Q65,30 140,10 Q215,-6 290,14 Q350,30 400,6" stroke="rgba(0,0,0,.35)" strokeWidth="1.6" fill="none" vectorEffect="non-scaling-stroke" />
          {Array.from({ length: 14 }, (_, i) => {
            const x = 8 + i * 28;
            const y = 6 + Math.abs(Math.sin((x / 390) * Math.PI * 2.2)) * 16;
            return <ellipse key={i} className={i % 2 ? 'hd-tw-a' : 'hd-tw-b'} cx={x} cy={y} rx="3.4" ry="4.6" fill={BULBS[i % 4]} />;
          })}
        </svg>
      )}
      {holiday === 'halloween' && (
        <>
          <svg className="hd-web" width="92" height="92" viewBox="0 0 120 120">
            <g stroke="rgba(255,255,255,.35)" strokeWidth="1" fill="none">
              <path d="M120,0 L8,32 M120,0 L32,88 M120,0 L88,112" />
              <path d="M98,6 Q102,22 114,26 M74,14 Q84,44 108,50 M52,20 Q70,68 100,76" />
            </g>
          </svg>
          <div className="hd-spider">
            <div className="hd-thread" />
            <svg width="22" height="18" viewBox="0 0 34 28">
              <g stroke="#0d0718" strokeWidth="2" fill="none" strokeLinecap="round">
                <path d="M13,12 l-9,-6 l-3,4 M13,14 l-10,0 l-2,5 M13,16 l-9,5 l-1,5 M21,12 l9,-6 l3,4 M21,14 l10,0 l2,5 M21,16 l9,5 l1,5" />
              </g>
              <ellipse cx="17" cy="14" rx="6" ry="7" fill="#0d0718" />
              <circle cx="15" cy="12" r="1.2" fill="#ff8a1c" />
              <circle cx="19" cy="12" r="1.2" fill="#ff8a1c" />
            </svg>
          </div>
          <svg className="hd-bat" width="34" height="17" viewBox="0 0 40 20">
            <path d="M20,9 C16,2 10,2 2,4 C6,6 7,9 6,12 C9,10 12,11 14,14 C16,11 18,11 20,13 C22,11 24,11 26,14 C28,11 31,10 34,12 C33,9 34,6 38,4 C30,2 24,2 20,9 Z" fill="#0d0718" />
          </svg>
        </>
      )}
      {holiday === 'easter' && (
        <div className="hd-eggs">
          {[
            ['#f6b8c8', 20, 26],
            ['#ffe28a', 24, 31],
            ['#c9e7b0', 18, 23],
          ].map(([c, w, h]) => (
            <svg key={c} width={w} height={h} viewBox="0 0 40 52">
              <path d="M20,2 C31,2 38,20 38,32 C38,43 30,50 20,50 C10,50 2,43 2,32 C2,20 9,2 20,2 Z" fill={c as string} />
              <path d="M3,26 q5,-5 10,0 t10,0 t10,0 t6,0" stroke="#ffffff" strokeWidth="3" fill="none" />
            </svg>
          ))}
        </div>
      )}
      {holiday === 'newyear' && (
        <svg className="hd-confetti" viewBox="0 0 390 200" preserveAspectRatio="xMaxYMin slice">
          {CONFETTI.map(([x, y, c, r], i) => (
            <rect key={i} className={i % 2 ? 'hd-tw-a' : 'hd-tw-b'} x={x} y={y} width="5" height="9" rx="1.5" fill={c} transform={`rotate(${r} ${x} ${y})`} />
          ))}
        </svg>
      )}
      {holiday === 'australia' && (
        <svg className="hd-cross" viewBox="0 0 390 330" preserveAspectRatio="xMaxYMin meet">
          {(
            [
              [318, 60, 14, 7],
              [290, 104, 14, 7],
              [348, 98, 14, 7],
              [322, 150, 14, 7],
              [330, 118, 7, 5],
            ] as const
          ).map(([x, y, r, n]) => (
            <polygon key={`${x}-${y}`} points={star(x, y, r, n)} fill="#ffffff" />
          ))}
        </svg>
      )}
    </div>
  );
}

/** Christmas: a Santa hat on a button (the button is position: relative). */
export function SantaHat() {
  return (
    <svg className="hd-hat" width="30" height="26" viewBox="0 0 30 26" aria-hidden="true">
      <path d="M3,22 Q8,4 22,8 Q19,12 19,20 Z" fill="#C8102E" />
      <path d="M1,23 Q10,18 21,21" stroke="#ffffff" strokeWidth="4.4" fill="none" strokeLinecap="round" />
      <circle cx="23" cy="8" r="3" fill="#ffffff" />
    </svg>
  );
}

/** Easter: bunny ears behind a word (the name in the greeting). */
export function BunnyEars() {
  return (
    <svg className="hd-ears" width="36" height="30" viewBox="0 0 36 30" aria-hidden="true">
      <ellipse cx="11" cy="15" rx="5" ry="13" fill="#F6F1E4" transform="rotate(-12 11 15)" />
      <ellipse cx="11" cy="16" rx="2.4" ry="9" fill="#f6b8c8" transform="rotate(-12 11 16)" />
      <ellipse cx="25" cy="15" rx="5" ry="13" fill="#F6F1E4" transform="rotate(12 25 15)" />
      <ellipse cx="25" cy="16" rx="2.4" ry="9" fill="#f6b8c8" transform="rotate(12 25 16)" />
    </svg>
  );
}
