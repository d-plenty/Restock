import { useEffect, useState } from 'react';
import { updateSettings } from '../../lib/db';
import { syncAvailable, syncInfo, type SyncInfo } from '../../lib/sync';
import { SECTION_NAMES, type Section } from '../../shops';
import type { Settings } from '../../types';
import { Icon } from '../components';
import { useNav } from '../nav';
import { startTour } from '../Tour';
import { noticeSetUpTiles, tilesLeft } from './Setup';
import { SHARE_TABS, shareTab } from './Sync';

/**
 * 0.8.5: the household started sharing a tab this phone doesn't (the owner turned on Pharmacy,
 * say): ask once whether to share it here too.
 */
function TabOffer({ settings }: { settings: Settings }) {
  const nav = useNav();
  const [info, setInfo] = useState<SyncInfo>();
  useEffect(() => {
    if (syncAvailable()) void syncInfo().then(setInfo, () => undefined);
  }, []);
  if (!info?.paired) return null;
  const tab = (info.householdTabs ?? []).find((t) => !(info.tabs ?? []).includes(t) && !(settings.seenTabOffers ?? []).includes(t)) as
    Section | undefined;
  if (!tab) return null;
  const what = SHARE_TABS.find((t) => t.tab === tab)!;
  const seen = () => updateSettings({ seenTabOffers: [...new Set([...(settings.seenTabOffers ?? []), tab])] });
  return (
    <div className="card nudge" role="status">
      <span className="title" style={{ fontSize: 15 }}>
        {info.household ?? 'Your household'} now shares {what.title.toLowerCase()}
      </span>
      <span className="small">
        Share the {SECTION_NAMES[tab]} tab on this phone too? The household's {what.title.toLowerCase()} things come across at the next sync. You can
        change it any time in Settings → Local sync.
      </span>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          className="btn small primary"
          onClick={() =>
            void shareTab(info, tab).then(async (i) => {
              await seen();
              if (i) {
                setInfo(i);
                nav.toast(`Sharing ${what.title.toLowerCase()} with the household`);
              }
            })
          }
        >
          Share it
        </button>
        <button className="btn small" onClick={() => void seen()}>
          Not on this phone
        </button>
      </div>
    </div>
  );
}

/** Home: "Finish setting up" (until done or dismissed) and "Take the tour" (until taken or dismissed). */
export function SetupNudges({ settings }: { settings: Settings }) {
  const nav = useNav();
  const left = tilesLeft(settings);
  // Set up without anyone tapping Next (permissions allowed, a card added): counts as done.
  useEffect(() => {
    void noticeSetUpTiles();
  }, []);
  return (
    <>
      <TabOffer settings={settings} />
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
