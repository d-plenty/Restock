import { useEffect, useState } from 'react';
import { findCatalogue, type CatalogueLink } from '../../lib/catalogues';
import { getSettings } from '../../lib/db';
import { useLive } from '../../lib/useLive';
import { activeSections, chainName, enabledIn, hostOf, sectionOf, websiteOf, type Section, type StoreChain } from '../../shops';
import { isNative } from '../../stores/http';
import { storeChoice, type Settings } from '../../types';
import { ChainDot, Icon, TopBar } from '../components';

const GROUP: Record<Section, string> = { pantry: 'Groceries', keg: 'Keg', pharmacy: 'Pharmacy' };

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
      chains: [...new Set([...enabledIn(settings.enabledChains, section), ...withStore.filter((c) => sectionOf(c) === section && websiteOf(c))])],
    }))
    .filter((g) => g.chains.length > 0);
}

function CatalogueRow({ chain }: { chain: StoreChain }) {
  const [link, setLink] = useState<CatalogueLink>();
  useEffect(() => {
    void findCatalogue(chain).then(setLink, () => setLink({ missing: 'unchecked' }));
  }, [chain]);
  const site = websiteOf(chain);
  // Plain links: the app hands outside web addresses to the phone's browser.
  return (
    <div className="row" style={{ flexWrap: 'wrap' }}>
      <ChainDot chain={chain} />
      <span className="grow" style={{ minWidth: 150 }}>
        <span className="title">{chainName(chain)}</span>
        <span className="small">
          {!link
            ? 'Looking for a catalogue…'
            : link.url
              ? (link.note ?? hostOf(link.url))
              : link.missing === 'unchecked'
                ? isNative()
                  ? "Couldn't check for a catalogue just now."
                  : 'Checking for a catalogue works in the Android app.'
                : `No catalogue found on ${site ? hostOf(site) : 'its website'}.`}
        </span>
      </span>
      <span style={{ display: 'flex', gap: 6 }}>
        {link?.url && (
          <a className="btn small primary" href={link.url} style={{ textDecoration: 'none' }} aria-label={`${chainName(chain)} catalogue`}>
            <Icon name="book" size={16} /> Catalogue
          </a>
        )}
        {site && (
          <a className="btn small" href={site} style={{ textDecoration: 'none' }} aria-label={`${chainName(chain)} website`}>
            <Icon name="external" size={16} /> Website
          </a>
        )}
      </span>
    </div>
  );
}

export function CataloguesScreen() {
  const settings = useLive(getSettings, []);
  if (!settings) return <div className="screen" />;
  const groups = catalogueShops(settings);
  return (
    <div className="screen">
      <TopBar title="Catalogues" />
      <p className="sub">
        The catalogue for each shop you use. Catalogue opens the shop's own catalogue, Website opens its site, both in your web browser.
      </p>
      {groups.map(({ section, chains }) => (
        <div key={section} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div className="eyebrow" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Icon name={section} size={15} /> {GROUP[section]}
          </div>
          <div className="card flush">
            {chains.map((c) => (
              <CatalogueRow key={c} chain={c} />
            ))}
          </div>
        </div>
      ))}
      {!groups.length && <p className="small">Pick your shops in Settings → My shops to see their catalogues here.</p>}
      <p className="small">
        Catalogue prices can differ by state and store. Your items' prices are checked automatically, so you don't need to hunt for them here.
      </p>
    </div>
  );
}
