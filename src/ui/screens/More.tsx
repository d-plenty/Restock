// 0.10.4: the navy top (design A): the tabs in use as colour tiles, the others as dashed buttons.
// 0.10.3: More, the fifth place on the bottom bar (Home, Pantry, Add, List, More). It holds the tabs
// besides Pantry (Keg, Health, Baby and Pets, once they're set up), a way to set up the others,
// and Settings, Cards, Catalogues, Specials and Receipts. The web page's phone layout shows the
// same tab rows on its own More (PhoneLayout.tsx MorePage), so the phone and the web match.
import { useState, type ReactNode } from 'react';

import { loadRecommendations } from '../../lib/recs';
import { useLive, useSettings } from '../../lib/useLive';
import type { Recommendation } from '../../lib/verdict';
import { chainName, customDef, EXTRA_SECTIONS, enabledIn, MAX_CUSTOM, SECTION_NAMES, type Section } from '../../shops';
import { customsInUse, NewCustomSheet } from './CustomSections';
import type { Chain } from '../../types';
import { serverMode } from '../../server-mode/flag';
import { BetaTag, Icon } from '../components';
import { useNav } from '../nav';

/** 0.10.4: what a tab's tile says: how many things, how many on special, and the shop that's cheapest most often. */
function tabSummary(recs: Recommendation[] | undefined, section: Section): { things: number; onSpecial: number; cheapest?: Chain } {
  const mine = (recs ?? []).filter((r) => (r.group.section ?? 'pantry') === section);
  const onSpecial = mine.filter((r) => r.action === 'buy' || r.action === 'small' || r.action === 'alt').length;
  const wins = new Map<Chain, number>();
  for (const r of mine) {
    const c = r.best?.product.chain;
    if (c && c !== 'other') wins.set(c, (wins.get(c) ?? 0) + 1);
  }
  let cheapest: Chain | undefined;
  for (const [c, n] of wins) if (!cheapest || n > (wins.get(cheapest) ?? 0)) cheapest = c;
  return { things: mine.length, onSpecial, cheapest };
}

/**
 * 0.10.4 (design A, with a navy top): More's title, the tabs in use as colour tiles (two across:
 * what's in each, what's on special, the shop that's cheapest), and a small dashed button for each
 * tab that isn't set up. A tab switched off from More (Settings: Show it in More) isn't shown, but
 * still works. The web page's phone layout shows the same (PhoneLayout.tsx MorePage).
 */
export function MoreTop({ children }: { children?: ReactNode }) {
  const nav = useNav();
  const settings = useSettings();
  const recs = useLive(loadRecommendations, []);
  // 0.10.7: a custom section shows as soon as it's made, before its shops are picked (tapping it opens its page in Settings).
  const shown = settings
    ? EXTRA_SECTIONS.filter((s) => !!settings.sections?.[s])
    : [];
  // 0.12.5: Bottle shop and Chemist aren't offered on More itself any more. They're two of the starts inside "Create a custom tab".
  // 0.13.0: they're tabs you make like any other, so there's room while any slot is free
  const builtInFree = settings ? (['keg', 'pharmacy'] as const).some((s) => !settings.sections?.[s]) : false;
  const customRoom = settings ? customsInUse(settings).length < MAX_CUSTOM : false;
  const [making, setMaking] = useState(false);
  return (
    <div className="more-top">
      <h1>More</h1>
      {children}
      {shown.length > 0 && (
        <>
          <h2 className="more-top-label">Your tabs</h2>
          <div className="more-tiles">
            {shown.map((s) => {
              const t = tabSummary(recs, s);
              const shops = settings ? enabledIn(settings.enabledChains, s, settings.shopTabs ?? {}) : [];
              return (
                <button
                  key={s}
                  className={`more-tile tile-colour-${customDef(settings, s).colour}`}
                  onClick={() => {
                    if (shops.length) return nav.setTab(s);
                    nav.push({ name: 'settings' });
                    if (!serverMode) nav.push({ name: 'stores', section: s });
                  }}
                >
                  <span className="more-tile-icon">
                    <Icon name={s} size={24} />
                  </span>
                  {/* 0.13.0: every tab you made says Beta, in its top right corner */}
                  <span className="more-tile-beta">
                    <BetaTag />
                  </span>
                  <span className="more-tile-name">
                    {SECTION_NAMES[s]}
                  </span>
                  <span className="more-tile-count">
                    {t.things ? `${t.things} ${t.things === 1 ? 'item' : 'items'} · ${t.onSpecial} on special` : 'Nothing yet'}
                  </span>
                  <span className="more-tile-shop">
                    {t.cheapest ? `Cheapest at ${chainName(t.cheapest)}` : shops.length ? shops.map(chainName).join(' · ') : 'No shops picked yet'}
                  </span>
                </button>
              );
            })}
          </div>
        </>
      )}
      {(builtInFree || customRoom) && (
        <div className="more-adds">
          {/* 0.12.5: one button. Chemist, Bottle shop, Baby, Pets, Automotive, Tools, Office and Your own are picked inside it; none is put here ahead of time. */}
          <button className="more-add more-custom" onClick={() => (serverMode ? nav.push({ name: 'settings' }) : setMaking(true))}>
            <Icon name="pack:star" size={20} />
            <span className="grow" style={{ display: 'flex', flexDirection: 'column', textAlign: 'left' }}>
              <span>Create a custom tab</span>
              <span className="more-custom-about">Chemist, bottle shop, baby, pets, automotive, tools, office or your own</span>
            </span>
            <Icon name="plus" size={18} />
          </button>
        </div>
      )}
      {making && <NewCustomSheet onClose={() => setMaking(false)} />}
    </div>
  );
}

const TONES: Record<string, 'green' | 'amber' | 'pink' | 'blue' | 'purple' | 'teal' | 'orange' | 'slate'> = {
  settings: 'slate',
  card: 'blue',
  shop: 'green',
  receipt: 'amber',
};

/** The rows under the navy top, the same five on the phone and the web page. */
function MoreRow({ icon, title, sub, onClick, off }: { icon: string; title: string; sub: string; onClick: () => void; off?: boolean }) {
  return (
    <button className="row" onClick={onClick}>
      {/* 0.16.0: in a coloured tile, like Settings' rows */}
      <span className="row-tile" data-tone={TONES[icon] ?? 'slate'} aria-hidden="true">
        <Icon name={icon} size={20} />
      </span>
      <span className="grow">
        <span className="title" style={{ fontSize: 15 }}>
          {title}
        </span>
        <span className={`small${off ? ' muted' : ''}`}>{sub}</span>
      </span>
      <Icon name="chevron" size={18} />
    </button>
  );
}

export function MoreScreen() {
  const nav = useNav();
  const settings = useSettings();
  return (
    <div className="screen more-screen">
      <MoreTop />
      <div className="eyebrow">Everything else</div>
      <div className="card flush">
        <MoreRow icon="settings" title="Settings" sub="Shops, lists, look, sync and more" onClick={() => nav.push({ name: 'settings' })} />
        <MoreRow icon="card" title="Cards" sub="Loyalty, membership and gift cards" onClick={() => nav.push({ name: 'cards' })} />
        {/* 0.12.3: one row (Open my catalogue is merged into each shop's page): your shops, each with your specials there and its website */}
        <MoreRow icon="shop" title="Your shops" sub="Your specials at each shop, and its website" onClick={() => nav.push({ name: 'catalogues' })} />
        <MoreRow
          icon="receipt"
          title="Receipts"
          sub={settings?.receipts.enabled ? 'What you spent' : 'Off: turn them on in Settings'}
          off={!settings?.receipts.enabled}
          onClick={() => nav.push({ name: 'receipts' })}
        />
      </div>
    </div>
  );
}
