// 0.16.0: Settings → Look and colours → See the openings: the usual one and every holiday's, in
// its day and night look, played on the spot, so they can be seen without waiting for the date.
// With Less motion on they show as the still picture, as they would at start.
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { HOLIDAY_NAMES, type Holiday } from '../lib/holiday';
import { layerHost, Sheet } from './components';
import { Opening, type OpeningLook } from './Opening';

const ALL: (Holiday | 'none')[] = ['none', 'christmas', 'newyear', 'australia', 'easter', 'halloween'];
const nameOf = (h: Holiday | 'none') => (h === 'none' ? 'The usual one' : HOLIDAY_NAMES[h]);
const WHEN: Record<Holiday | 'none', string> = {
  none: 'The rest of the year',
  christmas: '1 to 26 December',
  newyear: '27 December to 1 January',
  australia: '2 to 31 January',
  easter: 'The two weeks up to Easter Monday',
  halloween: 'October',
};

export function OpeningPreview({ onClose, still }: { onClose: () => void; still: boolean }) {
  const [playing, setPlaying] = useState<{ h: Holiday | 'none'; look: OpeningLook }>();
  return (
    <>
      <Sheet title="See the openings" onClose={onClose}>
        <p className="small">Tap one to play it. Day is how it looks in light mode, night in dark mode.</p>
        <div className="card flush">
          {ALL.map((h) => (
            <div key={h} className="row">
              <span className="grow">
                <span className="title">{nameOf(h)}</span>
                <span className="small">{WHEN[h]}</span>
              </span>
              {h === 'none' ? (
                <button className="btn small" onClick={() => setPlaying({ h, look: 'night' })} aria-label="Play the usual opening">
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
            </div>
          ))}
        </div>
      </Sheet>
      {playing &&
        createPortal(
          <Opening key={`${playing.h}-${playing.look}`} holiday={playing.h === 'none' ? undefined : playing.h} look={playing.look} still={still} onDone={() => setPlaying(undefined)} />,
          layerHost(),
        )}
    </>
  );
}
