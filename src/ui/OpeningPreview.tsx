// 0.16.0: Settings → Look and colours → See the animations: the usual one and every holiday's, in
// its day and night look, played on the spot, so they can be seen without waiting for the date.
// 0.17.0: laid out as Plenty Flow's: a small picture of each, its dates, Day and Night, and
// "showing now" on the one that plays today. A playing one always lets you out: a tap, the phone's
// Back, or Escape; it ends by itself too, and you're back on this list. With Less motion on they're
// the still picture, as at start.
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { HOLIDAY_NAMES, HOLIDAY_WHEN, holidayNow, type Holiday } from '../lib/holiday';
import { isDark } from '../lib/theme';
import type { Settings } from '../types';
import { layerHost, Sheet, useBackLayer } from './components';
import { Opening, type OpeningLook } from './Opening';

const ALL: (Holiday | 'none')[] = ['none', 'christmas', 'newyear', 'australia', 'easter', 'halloween'];
const nameOf = (h: Holiday | 'none') => (h === 'none' ? 'The usual one' : HOLIDAY_NAMES[h]);
const WHEN: Record<Holiday | 'none', string> = { none: 'The rest of the year', ...HOLIDAY_WHEN };

type Playing = { h: Holiday | 'none'; look: OpeningLook };

/** One playing, over everything; out with a tap, Back or Escape. */
function Player({ playing, still, onEnd }: { playing: Playing; still: boolean; onEnd: () => void }) {
  useBackLayer(onEnd);
  return createPortal(
    <Opening key={`${playing.h}-${playing.look}`} holiday={playing.h === 'none' ? undefined : playing.h} look={playing.look} still={still} onDone={onEnd} />,
    layerHost(),
  );
}

export function OpeningPreview({ onClose, still, settings }: { onClose: () => void; still: boolean; settings?: Pick<Settings, 'look' | 'theme'> }) {
  const [playing, setPlaying] = useState<Playing>();
  const nowH = settings ? (settings.look.opening === false ? undefined : (holidayNow(settings) ?? 'none')) : undefined;
  const nowLook: OpeningLook = settings && isDark(settings.theme) ? 'night' : 'day';
  return (
    <>
      <Sheet title="See the animations" onClose={onClose}>
        <p className="small" style={{ margin: 0 }}>
          Day is how it looks in light mode, night in dark mode.
        </p>
        <div className="card flush op-list">
          {ALL.map((h) => (
            <div key={h} className="row op-list-row">
              <span className="op-thumb-box">
                <Opening thumb holiday={h === 'none' ? undefined : h} look={h === nowH ? nowLook : 'day'} />
              </span>
              <span className="grow">
                <span className="title">{nameOf(h)}</span>
                <span className="small">
                  {WHEN[h]}
                  {h === nowH && <strong className="op-now"> · showing now</strong>}
                </span>
              </span>
              <span className="op-list-btns">
                {h === 'none' ? (
                  <button className="btn small" onClick={() => setPlaying({ h, look: 'night' })} aria-label="Play the usual one">
                    Play
                  </button>
                ) : (
                  <>
                    <button className="btn small" onClick={() => setPlaying({ h, look: 'day' })} aria-label={`Play ${nameOf(h)}, day`}>
                      Day
                    </button>
                    <button className="btn small" onClick={() => setPlaying({ h, look: 'night' })} aria-label={`Play ${nameOf(h)}, night`}>
                      Night
                    </button>
                  </>
                )}
              </span>
            </div>
          ))}
        </div>
      </Sheet>
      {playing && <Player playing={playing} still={still} onEnd={() => setPlaying(undefined)} />}
    </>
  );
}
