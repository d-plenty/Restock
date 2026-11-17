import { getSettings } from '../../lib/db';
import { useLive } from '../../lib/useLive';
import { activeSections, chainName, enabledIn, hostOf, shopDef, shopOnTab, websiteOf, type Section, type StoreChain, withCustom } from '../../shops';
import { serverMode } from '../../server-mode/flag';
import { storeChoice, type Settings } from '../../types';
import { ChainDot, Icon, TopBar } from '../components';
import { useNav } from '../nav';

const GROUP: Record<Section, string> = withCustom({ pantry: 'Groceries', keg: 'Bottle shop', pharmacy: 'Chemist' }, (n) => n);

/**
 * Your shops, by tab: every shop you've ticked, or made a store your primary or second one, on a
 * tab that's switched on.
 */
export function catalogueShops(settings: Settings): { section: Section; chains: StoreChain[] }[] {
  const withStore = (Object.keys(settings.stores) as StoreChain[]).filter(
    (c) => storeChoice(settings, c).primary || storeChoice(settings, c).secondary,
  );
  return activeSections(settings)
    .map((section) => ({
      section,
      chains: [...new Set([...enabledIn(settings.enabledChains, section), ...withStore.filter((c) => shopOnTab(c, section) && websiteOf(c))])],
    }))
    .filter((g) => g.chains.length > 0);
}

/** 0.9.0: only an https web address is ever shown as a link (a catalogue link is read off the shop's website). */
export function httpsLink(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}

/** One of your shops: its catalogue (in Restock) and its website (in your browser). */
function ShopRow({ chain }: { chain: StoreChain }) {
  const nav = useNav();
  const site = httpsLink(websiteOf(chain));
  const note = shopDef(chain)?.catalogue?.note ?? (site ? hostOf(site) : undefined);
  return (
    <div className="row shop-row">
      <ChainDot chain={chain} />
      <span className="grow" style={{ minWidth: 0 }}>
        <span className="title">{chainName(chain)}</span>
        {note && <span className="small">{note}</span>}
      </span>
      <span className="shop-row-btns">
        <button className="btn small primary" onClick={() => nav.push({ name: 'shopcatalogue', chain })} aria-label={`${chainName(chain)} catalogue`}>
          <Icon name="book" size={16} /> Catalogue
        </button>
        {site && (
          <a
            className="btn small"
            href={site}
            {...(serverMode ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
            style={{ textDecoration: 'none' }}
            aria-label={`${chainName(chain)} website${serverMode ? ' (opens a new tab)' : ''}`}
          >
            <Icon name="external" size={16} /> Website
          </a>
        )}
      </span>
    </div>
  );
}

/** Every shop you use, once, in the order of your tabs (Home's square buttons). */
export function yourShops(settings: Settings): StoreChain[] {
  return [...new Set(catalogueShops(settings).flatMap((g) => g.chains))];
}

// 0.12.2: More → Your shops (it was Catalogues and specials: My catalogue has its own row in More
// now, and each shop's specials are its Catalogue button here).
export function CataloguesScreen() {
  const nav = useNav();
  const settings = useLive(getSettings, []);
  if (!settings) return <div className="screen" />;
  const groups = catalogueShops(settings);
  return (
    <div className="screen">
      <TopBar title="Your shops" />
      <p className="sub">Catalogue shows a shop's specials here in Restock. Website opens the shop's own site in your web browser.</p>
      {groups.map(({ section, chains }) => (
        <div key={section} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {groups.length > 1 && (
            <div className="eyebrow" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Icon name={section} size={15} /> {GROUP[section]}
            </div>
          )}
          <div className="card flush">
            {chains.map((c) => (
              <ShopRow key={c} chain={c} />
            ))}
          </div>
        </div>
      ))}
      {!groups.length && <p className="small">You haven't picked any shops yet.</p>}
      <button className="btn" onClick={() => nav.push({ name: 'settings' })}>
        {groups.length ? 'Add or remove shops in Settings' : 'Pick your shops in Settings'}
      </button>
    </div>
  );
}
