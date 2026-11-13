// 0.10.4: the navy top (design A): the tabs in use as colour tiles, the others as dashed buttons.
// 0.10.3: More, the fifth place on the bottom bar (Home, Pantry, Add, List, More). It holds the tabs
// besides Pantry (Keg, Health, Baby and Pets, once they're set up), a way to set up the others,
// and Settings, Cards, Catalogues, Specials and Receipts. The web page's phone layout shows the
// same tab rows on its own More (PhoneLayout.tsx MorePage), so the phone and the web match.
import type { ReactNode } from 'react';
import { getSettings } from '../../lib/db';
import { loadRecommendations } from '../../lib/recs';
import { useLive } from '../../lib/useLive';
import type { Recommendation } from '../../lib/verdict';
import { chainName, EXTRA_SECTIONS, enabledIn, SECTION_NAMES, sectionOn, type Section } from '../../shops';
import type { Chain } from '../../types';
import { serverMode } from '../../server-mode/flag';
import { BetaTag, Icon } from '../components';
import { useNav } from '../nav';

/** What each tab is for, under its name when it isn't set up yet. */
const TAB_FOR: Record<Exclude<Section, 'pantry'>, string> = {
  keg: 'Beer, wine and spirits at the bottle shops you pick (18+)',
  pharmacy: 'Medicine, first aid and personal care at the shops you pick',
  baby: 'Nappies, wipes and formula at the shops you pick',
  pets: 'Pet food, litter and treats at the shops you pick',
};

/** 0.10.4: what a tab's tile says: how many things, how many on special, and the shop that's cheapest most often. */
export function tabSummary(recs: Recommendation[] | undefined, section: Section): { things: number; onSpecial: number; cheapest?: Chain } {
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
  const settings = useLive(getSettings, []);
  const recs = useLive(loadRecommendations, []);
  const shown = settings ? EXTRA_SECTIONS.filter((s) => sectionOn(settings, s) && !settings.hiddenTabs?.includes(s)) : [];
  const notYet = settings ? EXTRA_SECTIONS.filter((s) => !sectionOn(settings, s)) : [];
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
                <button key={s} className={`more-tile tile-${s}`} onClick={() => nav.setTab(s)}>
                  <span className="more-tile-icon">
                    <Icon name={s} size={24} />
                  </span>
                  <span className="more-tile-name">
                    {SECTION_NAMES[s]} <BetaTag />
                  </span>
                  <span className="more-tile-count">
                    {t.things ? `${t.things} ${t.things === 1 ? 'thing' : 'things'} · ${t.onSpecial} on special` : 'Nothing yet'}
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
      {notYet.length > 0 && (
        <>
          <h2 className="more-top-label">{shown.length ? 'Add a tab' : 'Add a tab: Keg, Health, Baby or Pets'}</h2>
          <div className="more-adds">
            {notYet.map((s) => (
              // On the web page, the household's shops are set in Settings (a phone sets its own on its shop pages).
              <button
                key={s}
                className="more-add"
                aria-label={`Set up ${SECTION_NAMES[s]}: ${TAB_FOR[s]}`}
                onClick={() => nav.push(serverMode ? { name: 'settings' } : { name: 'stores', section: s })}
              >
                <Icon name={s} size={20} />
                <span className="grow">{SECTION_NAMES[s]}</span>
                <Icon name="plus" size={18} />
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** The rows under the navy top, the same five on the phone and the web page. */
export function MoreRow({ icon, title, sub, onClick, off }: { icon: string; title: string; sub: string; onClick: () => void; off?: boolean }) {
  return (
    <button className="row" onClick={onClick}>
      <Icon name={icon} size={22} />
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
  const settings = useLive(getSettings, []);
  return (
    <div className="screen more-screen">
      <MoreTop />
      <div className="eyebrow">Everything else</div>
      <div className="card flush">
        <MoreRow icon="settings" title="Settings" sub="Shops, lists, look, sync and more" onClick={() => nav.push({ name: 'settings' })} />
        <MoreRow icon="card" title="Cards" sub="Loyalty, membership and gift cards" onClick={() => nav.push({ name: 'cards' })} />
        <MoreRow icon="book" title="Catalogues" sub="Your shops' catalogues" onClick={() => nav.push({ name: 'catalogues' })} />
        <MoreRow icon="flame" title="Specials" sub="What your shops have on special" onClick={() => nav.push({ name: 'specials' })} />
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
