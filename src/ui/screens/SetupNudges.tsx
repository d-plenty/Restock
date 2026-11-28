import { useEffect, useState } from 'react';
import { updateSettings } from '../../lib/db';
import { syncAvailable, syncInfo, type SyncInfo } from '../../lib/sync';
import { SECTION_NAMES, type Section } from '../../shops';
import type { Settings } from '../../types';
import { useNav } from '../nav';
import { SHARE_TABS, shareTab } from './Sync';

/**
 * 0.8.5: the household started sharing a tab this phone doesn't (the owner turned on Pharmacy,
 * say): ask once whether to share it here too.
 */
export function TabOffer({ settings }: { settings: Settings }) {
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
        change it any time in Settings → Sync → Phones and sharing.
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
