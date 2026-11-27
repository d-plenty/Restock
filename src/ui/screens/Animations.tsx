// 0.18.1: Settings → Look and colours → Animations: the opening animation, the holiday themes and
// each holiday on its own, and every animation to play on the spot (it was three switches and a See
// the animations button on Look and colours). The same on the phone (a page of Settings) and on the
// server's web page (a sheet there, for this browser).
import { HOLIDAY_NAMES, HOLIDAY_ORDER, HOLIDAY_WHEN } from '../../lib/holiday';
import type { Settings } from '../../types';
import { More } from '../components';
import { lessMotion } from '../Opening';
import { AnimationList } from '../OpeningPreview';

type Look = Settings['look'];

/** How the Animations row sums them up ("Opening on · Holidays on"). */
export function animationsSummary(look: Look): string {
  if (look.opening === false) return 'Off';
  return look.holidays === false ? 'Opening on · Holidays off' : 'Opening on · Holidays on';
}

export function AnimationsSettings({ settings, setLook, web }: { settings: Pick<Settings, 'look' | 'theme' | 'a11y'>; setLook: (patch: Partial<Look>) => unknown; web?: boolean }) {
  const look = settings.look;
  const mine = web ? 'Just for this browser.' : 'Just for this phone.';
  return (
    <>
      {look.style === 'simple' && (
        <p className="small" style={{ margin: 0 }}>
          Simple turns these off to keep things light. Turn any of them back on here.
        </p>
      )}
      <div className="card" style={{ gap: 14 }}>
        <label className="check" style={{ padding: 0 }}>
          <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <span className="title" style={{ fontSize: 15 }}>
              Opening animation
            </span>
            <span className="small">
              A short animation when Restock starts.{' '}
              <More title="Opening animation">
                <p>Two and a half seconds (three and a half on a holiday), each time Restock starts from closed (not when you come back to it). A tap ends it early.</p>
                <p>With Less motion on (Accessibility, or your {web ? 'computer' : 'phone'}&rsquo;s own Reduce motion) it&rsquo;s a still picture instead. Turned off here, there&rsquo;s no opening at all, holidays included.</p>
                <p>{mine}</p>
              </More>
            </span>
          </span>
          <input type="checkbox" className="switch" checked={look.opening !== false} onChange={(e) => void setLook({ opening: e.target.checked })} />
        </label>

        <label className="check" style={{ padding: 0 }}>
          <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <span className="title" style={{ fontSize: 15 }}>
              Holiday themes
            </span>
            <span className="small">
              Christmas, New Year, Australia Day, Easter and Halloween.{' '}
              <More title="Holiday themes">
                <p>On a holiday Restock opens with that holiday&rsquo;s animation (with Opening animation on). On the default theme the app also takes the holiday&rsquo;s colours, with a small decoration at the top of Home.</p>
                <p>Christmas is 1 to 26 December, New Year 27 December to 1 January, Australia Day 19 to 27 January, Easter the three weeks up to Easter Monday, and Halloween 11 October to 1 November. Each looks like day in light mode and night in dark mode. Afterwards everything goes back to normal by itself.</p>
                <p>Turn any one off on its own below. {mine}</p>
              </More>
            </span>
          </span>
          <input type="checkbox" className="switch" checked={look.holidays !== false} onChange={(e) => void setLook({ holidays: e.target.checked })} />
        </label>
        {look.holidays !== false && (
          <div className="holiday-each" role="group" aria-label="Each holiday">
            {HOLIDAY_ORDER.map((h) => (
              <label key={h} className="check" style={{ padding: 0 }}>
                <span className="grow" style={{ display: 'flex', flexDirection: 'column' }}>
                  <span className="title" style={{ fontSize: 15 }}>
                    {HOLIDAY_NAMES[h]}
                  </span>
                  <span className="small">{HOLIDAY_WHEN[h]}</span>
                </span>
                <input
                  type="checkbox"
                  className="switch"
                  checked={!look.holidaysOff?.includes(h)}
                  onChange={(e) => {
                    const off = new Set(look.holidaysOff ?? []);
                    if (e.target.checked) off.delete(h);
                    else off.add(h);
                    void setLook({ holidaysOff: HOLIDAY_ORDER.filter((x) => off.has(x)) });
                  }}
                />
              </label>
            ))}
          </div>
        )}
      </div>

      <div className="eyebrow">Play them</div>
      <p className="small" style={{ margin: 0 }}>
        Day is how each looks in light mode, night in dark mode.
      </p>
      <AnimationList still={lessMotion(settings.a11y.motion)} settings={settings} />
    </>
  );
}
