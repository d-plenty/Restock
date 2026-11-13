// 0.10.3: More, the fifth place on the bottom bar (Home, Pantry, Add, List, More). It holds the tabs
// besides Pantry (Keg, Health, Baby and Pets, once they're set up), a way to set up the others,
// and Settings, Cards, Catalogues, Specials and Receipts. The web page's phone layout shows the
// same tab rows on its own More (PhoneLayout.tsx MorePage), so the phone and the web match.
import { allGroups, getSettings } from '../../lib/db';
import { useLive } from '../../lib/useLive';
import { chainName, EXTRA_SECTIONS, enabledIn, SECTION_NAMES, sectionOn, type Section } from '../../shops';
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

/**
 * The tabs reached from More: the ones set up (tap to open), then the ones that aren't (tap to set
 * one up). A tab switched off from More (Settings: Show it in More) isn't listed, but still works.
 */
export function MoreTabs() {
  const nav = useNav();
  const settings = useLive(getSettings, []);
  const groups = useLive(allGroups, []);
  if (!settings) return null;
  const shown = EXTRA_SECTIONS.filter((s) => sectionOn(settings, s) && !settings.hiddenTabs?.includes(s));
  const notYet = EXTRA_SECTIONS.filter((s) => !sectionOn(settings, s));
  const count = (s: Section) => groups?.filter((g) => (g.section ?? 'pantry') === s).length ?? 0;
  return (
    <>
      {shown.length > 0 && (
        <>
          <div className="eyebrow">Your tabs</div>
          <div className="card flush more-tabs">
            {shown.map((s) => {
              const n = count(s);
              const shops = enabledIn(settings.enabledChains, s, settings.shopTabs ?? {});
              return (
                <button key={s} className="row" onClick={() => nav.setTab(s)}>
                  <Icon name={s} size={22} />
                  <span className="grow">
                    <span className="title" style={{ fontSize: 15 }}>
                      {SECTION_NAMES[s]} <BetaTag />
                    </span>
                    <span className="small clip">
                      {n ? `${n} ${n === 1 ? 'thing' : 'things'}` : 'Nothing yet'} · {shops.map(chainName).join(', ')}
                    </span>
                  </span>
                  <Icon name="chevron" size={18} />
                </button>
              );
            })}
          </div>
        </>
      )}
      {notYet.length > 0 && (
        <>
          <div className="eyebrow">{shown.length ? 'Add another tab' : 'Add a tab'}</div>
          <div className="card flush more-tabs">
            {notYet.map((s) => (
              // On the web page, the household's shops are set in Settings (a phone sets its own on its shop pages).
              <button key={s} className="row" onClick={() => nav.push(serverMode ? { name: 'settings' } : { name: 'stores', section: s })}>
                <Icon name={s} size={22} />
                <span className="grow">
                  <span className="title" style={{ fontSize: 15 }}>
                    Set up {SECTION_NAMES[s]} <BetaTag />
                  </span>
                  <span className="small">{TAB_FOR[s]}</span>
                </span>
                <Icon name="plus" size={18} />
              </button>
            ))}
          </div>
        </>
      )}
    </>
  );
}

export function MoreScreen() {
  const nav = useNav();
  const settings = useLive(getSettings, []);
  const row = (icon: string, title: string, sub: string, go: () => void) => (
    <button className="row" onClick={go}>
      <Icon name={icon} size={22} />
      <span className="grow">
        <span className="title" style={{ fontSize: 15 }}>
          {title}
        </span>
        <span className="small">{sub}</span>
      </span>
      <Icon name="chevron" size={18} />
    </button>
  );
  return (
    <div className="screen">
      <div className="topbar">
        <h1>More</h1>
      </div>
      <MoreTabs />
      <div className="eyebrow">Everything else</div>
      <div className="card flush">
        {row('settings', 'Settings', 'Shops, lists, look, sync and more', () => nav.push({ name: 'settings' }))}
        {row('card', 'Cards', 'Loyalty, membership and gift cards', () => nav.push({ name: 'cards' }))}
        {row('book', 'Catalogues', "Your shops' catalogues", () => nav.push({ name: 'catalogues' }))}
        {row('flame', 'Specials', 'What your shops have on special', () => nav.push({ name: 'specials' }))}
        {!serverMode && row('receipt', 'Receipts', settings?.receipts.enabled ? 'What you spent' : 'Off: turn them on in Settings', () => nav.push({ name: 'receipts' }))}
      </div>
    </div>
  );
}
