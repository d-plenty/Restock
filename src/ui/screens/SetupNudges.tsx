import { updateSettings } from '../../lib/db';
import type { Settings } from '../../types';
import { Icon } from '../components';
import { useNav } from '../nav';
import { startTour } from '../Tour';
import { tilesLeft } from './Setup';

/** Home: "Finish setting up" (until done or dismissed) and "Take the tour" (until taken or dismissed). */
export function SetupNudges({ settings }: { settings: Settings }) {
  const nav = useNav();
  const left = tilesLeft(settings);
  return (
    <>
      {left.length > 0 && !settings.setup.dismissed && (
        <div className="card nudge">
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
            <span className="grow">
              <span className="title" style={{ fontSize: 15 }}>
                Finish setting up · {left.length} left
              </span>
              <span className="small">{left.map((t) => t.title).join(', ')}</span>
            </span>
            <button className="icon-btn" aria-label="Hide this" onClick={() => updateSettings({ setup: { ...settings.setup, dismissed: true } })}>
              <Icon name="close" size={16} />
            </button>
          </div>
          <button className="btn small primary" style={{ alignSelf: 'flex-start' }} onClick={() => nav.push({ name: 'setup' })}>
            Continue setup
          </button>
        </div>
      )}
      {!settings.tour.seen && (
        <div className="card nudge">
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
            <span className="grow">
              <span className="title" style={{ fontSize: 15 }}>
                New to Restock? Take the tour
              </span>
              <span className="small">A two-minute look round with sample items. They go away when the tour ends.</span>
            </span>
            <button className="icon-btn" aria-label="No thanks" onClick={() => updateSettings({ tour: { ...settings.tour, seen: true } })}>
              <Icon name="close" size={16} />
            </button>
          </div>
          <button className="btn small primary" style={{ alignSelf: 'flex-start' }} onClick={() => void startTour()}>
            Take the tour
          </button>
        </div>
      )}
    </>
  );
}
