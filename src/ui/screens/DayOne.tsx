import { useEffect, useState } from 'react';
import { MARKET_SHOPS, MARKET_WINDOWS, megabytes, windowCost, windowIndex, type MarketDays, type WindowIndex } from '../../lib/market';
import { updateSettings } from '../../lib/settingsDraft';
import { chainName } from '../../shops';
import type { Settings } from '../../types';

/**
 * 0.9.13: how much shared price history to keep (8 weeks, 6 months or 12 months), each with roughly
 * what it costs for the shops this phone uses: the weekly download and the space on the phone.
 * Used in Settings → Shopping and in setup.
 */
export function DayOneLengths({ settings, onPick }: { settings: Settings; onPick?: (days: MarketDays) => void }) {
  const [index, setIndex] = useState<WindowIndex>();
  useEffect(() => {
    let alive = true;
    void windowIndex().then((v) => alive && setIndex(v));
    return () => {
      alive = false;
    };
  }, []);
  const days = settings.marketData.days ?? 56;
  const chains = settings.enabledChains;
  const covered = chains.filter((c) => (MARKET_SHOPS as readonly string[]).includes(c));
  const notCovered = chains.filter((c) => !(MARKET_SHOPS as readonly string[]).includes(c));
  return (
    <div role="radiogroup" aria-label="How much shared price history" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span className="title" style={{ fontSize: 15 }}>
        How much history
      </span>
      {MARKET_WINDOWS.map((w) => {
        const cost = windowCost(w.days, chains, index);
        return (
          <label key={w.days} className="check" style={{ padding: '6px 0' }}>
            <input
              type="radio"
              name="dayone-days"
              checked={days === w.days}
              onChange={() => {
                void updateSettings({ marketData: { ...settings.marketData, days: w.days } });
                onPick?.(w.days);
              }}
            />
            <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
              <span className="title" style={{ fontSize: 15 }}>
                {w.label}
                {w.days === 56 ? ' (default)' : ''}
              </span>
              <span className="small">
                {cost.shops.length
                  ? `${cost.measured ? '' : 'About '}${megabytes(cost.download)} to download each week · about ${megabytes(cost.stored)} on this phone`
                  : 'None of your shops has shared history yet'}
                {w.days === 365 ? '. Covers once-a-year sales like Christmas and Easter.' : ''}
              </span>
            </span>
          </label>
        );
      })}
      <span className="small">
        {covered.length ? `For ${covered.map(chainName).join(', ')}, the shops you use.` : 'Pick Coles, Woolworths, Aldi or Costco in My shops to use this.'}
        {notCovered.length ? ` ${notCovered.map(chainName).join(', ')} ${notCovered.length === 1 ? "isn't" : "aren't"} collected yet, so ${notCovered.length === 1 ? 'it has' : 'they have'} no shared history.` : ''}
      </span>
    </div>
  );
}
