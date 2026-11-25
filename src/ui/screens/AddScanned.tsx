import type { Dispatch, SetStateAction } from 'react';
import type { Settings } from '../../types';
import type { Nav } from '../nav';
import { type BarcodeInfo } from '../../lib/barcode';
import { displayName, QUICK_PICKS } from '../../lib/lookup';
import { PackReader } from '../PackReader';
import { getSettings, updateSettings } from '../../lib/db';
import { nameHasSize } from '../../lib/naming';
import { brandOnly, type BestMatch, type Candidate, normaliseQuery } from '../../lib/searchHelp';
import { money, tidySize } from '../../lib/units';
import { type StoreProduct } from '../../stores';
import { type RankQuery } from '../../stores/rank';
import { chainName, type Chain, type Group } from '../../types';
import { SECTION_PLACE, type Section, type StoreChain } from '../../shops';
import { Icon, LoadingBar, MoreInfo, RowInfo, Thumb } from '../components';
import { OtherSizesCard } from '../OtherSizes';
import { keyOf } from './addPicks';
import { TAP, type ChainResult } from './addShared';

/** 0.15.1 (split from Add.tsx): after a scan: you already have this, what was scanned, What is it?, the best match at each shop, and other sizes. */
export function AddScanned(p: {
  addingToItem: boolean;
  alreadyHave: { group: Group; productKey: string; } | undefined;
  anyResults: boolean;
  auto: Map<string, BestMatch> | undefined;
  candidates: Candidate[] | undefined;
  changing: Chain | undefined;
  choose: (c: Candidate) => void;
  dismissedHave: boolean;
  handleBarcode: (code: string, force?: boolean, pressed?: boolean) => Promise<void>;
  isPicked: (k: string) => boolean;
  known: Group | undefined;
  linkBarcode: (productKey: string, code: string) => Promise<void>;
  lookingUp: boolean;
  nav: Nav;
  panelOpen: boolean;
  photoFor: (sp: StoreProduct) => string | undefined;
  picks: Map<string, StoreProduct>;
  rankQ: RankQuery;
  reset: () => void;
  results: Partial<Record<Chain, ChainResult>>;
  scanned: BarcodeInfo | undefined;
  search: (q: string, rq: RankQuery, sec?: Section, _pressed?: boolean, fresh?: Awaited<ReturnType<typeof getSettings>>) => Promise<void>;
  searched: StoreChain[];
  section: Section;
  setDismissedHave: Dispatch<SetStateAction<boolean>>;
  setPanelOpen: Dispatch<SetStateAction<boolean>>;
  setPreview: Dispatch<SetStateAction<StoreProduct | undefined>>;
  setSearchedFor: Dispatch<SetStateAction<string | undefined>>;
  setTerm: Dispatch<SetStateAction<string>>;
  setWhatIsIt: Dispatch<SetStateAction<string>>;
  settings: Settings | undefined;
  sizesBusy: string | undefined;
  sizesFor: StoreProduct | undefined;
  sizesKey: string;
  sizesPool: StoreProduct[];
  sizesSkip: Set<string> | undefined;
  toggle: (sp: StoreProduct) => void;
  whatIsIt: string;
}) {
  const { addingToItem, alreadyHave, anyResults, auto, candidates, changing, choose, dismissedHave, handleBarcode, isPicked, known, linkBarcode, lookingUp, nav, panelOpen, photoFor, picks, rankQ, reset, results, scanned, search, searched, section, setDismissedHave, setPanelOpen, setPreview, setSearchedFor, setTerm, setWhatIsIt, settings, sizesBusy, sizesFor, sizesKey, sizesPool, sizesSkip, toggle, whatIsIt } = p;
  return (
    <>
      {/* 0.10.7: you already have this: View it, Add anyway, or Cancel. Also when the barcode isn't
          linked to it yet but the shop's match is already in your pantry (scanned "pineapple" when you
          track "Canned pineapple"): then View it links the barcode, so next time it's known straight away. */}
      {scanned && (known || (alreadyHave && !dismissedHave)) && (
        <div className="card" role="region" aria-labelledby="already-have">
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <Thumb src={scanned.imageUrl} icon="scan" />
            <div style={{ flex: 1 }}>
              <div className="eyebrow green" id="already-have">
                {known ? `You already have this in ${SECTION_PLACE[known.section ?? section]}` : `Looks like you already have this in ${SECTION_PLACE[(alreadyHave?.group.section ?? section) as Section]}`}
              </div>
              <div className="title">{(known ?? alreadyHave?.group)?.name}</div>
            </div>
          </div>
          <div className="three-btns">
            <button
              className="btn primary"
              onClick={async () => {
                const g = known ?? alreadyHave?.group;
                if (!g) return;
                if (!known && alreadyHave) await linkBarcode(alreadyHave.productKey, scanned.barcode);
                nav.push({ name: 'item', groupId: g.id });
              }}
            >
              View it
            </button>
            <button
              className="btn"
              onClick={() => {
                if (known) void handleBarcode(scanned.barcode, true);
                else setDismissedHave(true);
              }}
            >
              Add anyway
            </button>
            <button
              className="btn"
              onClick={() => {
                setDismissedHave(false);
                reset();
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* 0.10.8: not as well as the "already have" card above (the same photo twice) */}
      {scanned && !known && !(alreadyHave && !dismissedHave) && (
        <div className="card" style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Thumb src={scanned.imageUrl} icon="scan" />
          <div style={{ flex: 1 }}>
            <div className="eyebrow green">Scanned {scanned.barcode}</div>
            <div className="title">{scanned.name ? displayName(scanned) : lookingUp ? 'Looking it up…' : "We don't know this barcode yet."}</div>
            {scanned.size && <div className="small">{tidySize(scanned.size, scanned.name)}</div>}
            {(scanned as { source?: string }).source && <div className="small">Found on {(scanned as { source?: string }).source}</div>}
          </div>
        </div>
      )}

      {scanned && !known && !scanned.name && !lookingUp && (
        <form
          className="card"
          onSubmit={(e) => {
            e.preventDefault();
            const t = whatIsIt.trim();
            if (!t) return;
            setTerm(t);
            const fixed = normaliseQuery(t);
            void search(fixed, { text: fixed, barcode: scanned.barcode }, section, true); // its Search button
          }}
        >
          <div className="title">What is it?</div>
          <p className="small">
            Photograph the front of the pack, or type the name. Restock remembers this barcode.
          </p>
          {/* 0.10.7: for everyone (it used to need the Receipts add-on), and Google Lens as the backup. */}
          <PackReader
            barcode={scanned.barcode}
            onName={(n, go) => {
              setWhatIsIt(n);
              if (!go) return;
              setTerm(n);
              setSearchedFor(n);
              const fixed = normaliseQuery(n);
              void search(fixed, { text: fixed, barcode: scanned.barcode });
            }}
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              className="input"
              value={whatIsIt}
              onChange={(e) => setWhatIsIt(e.target.value)}
              placeholder="Brand and product"
              aria-label="What is it?"
            />
            <button className="btn primary" type="submit" style={{ padding: '0 14px' }}>
              Search
            </button>
          </div>
          {QUICK_PICKS[section].length > 0 && (
            <div className="chips" role="group" aria-label="Quick picks">
              {QUICK_PICKS[section].map((q) => (
                <button
                  key={q}
                  type="button"
                  className="chip"
                  onClick={() => {
                    setWhatIsIt(q);
                    setTerm(q);
                    setSearchedFor(q);
                    void search(q.toLowerCase(), { text: q.toLowerCase(), barcode: scanned.barcode });
                  }}
                >
                  {q}
                </button>
              ))}
            </div>
          )}
        </form>
      )}

      {/* 0.12.0: a scan's best matches open as "your pick at each shop" (they were a card of tick boxes here) */}
      {auto && auto.size > 0 && picks.size > 0 && !panelOpen && !changing && (
        <div className="card best-match">
          <div className="eyebrow green">Best match</div>
          <strong>Found at {[...auto.keys()].map((c) => chainName(c)).join(auto.size === 2 ? ' and ' : ', ')}</strong>
          <button className="btn primary" onClick={() => setPanelOpen(true)}>
            See your pick at each shop
          </button>
        </div>
      )}
      {rankQ.barcode && !auto && searched.some((c) => !results[c] || results[c]?.status === 'loading') && (
        <div className="card best-match" role="status">
          <div className="eyebrow green">Best match</div>
          <span className="small">Finding this product at {searched.map((c) => chainName(c)).join(searched.length === 2 ? ' and ' : ', ')}…</span>
          <LoadingBar seconds={10} />
        </div>
      )}
      {auto && auto.size === 0 && rankQ.barcode && candidates && candidates.length > 0 && (
        <div className="card best-match">
          <div className="eyebrow green">Which one did you scan?</div>
          <span className="small">
            {brandOnly(rankQ) ? `The barcode only says the brand (${rankQ.brand}).` : `Not sure which ${rankQ.brand} product this is.`} Tap the one
            you've got.
          </span>
          <div className="card flush" style={{ boxShadow: 'none' }}>
            {candidates.map((c) => (
              <div key={keyOf(c.sp)} className="row" style={{ gap: 10 }}>
                <MoreInfo src={c.sp.imageUrl ?? photoFor(c.sp)} name={c.sp.name} onOpen={() => setPreview(c.sp)} />
                <button className="row-main" style={{ color: 'inherit', font: 'inherit', ...TAP }} onClick={() => choose(c)} aria-label={`It's ${c.sp.name}`}>
                  <span className="grow" style={{ textAlign: 'left' }}>
                    <span className="title" style={{ fontSize: 15 }}>
                      {c.sp.name}
                    </span>
                    <span className="small">
                      {c.sp.size && !nameHasSize(c.sp.name, c.sp.size) ? `${tidySize(c.sp.size, c.sp.name)} · ` : ''}
                      {c.at.map((p) => chainName(p.chain)).join(c.at.length === 2 ? ' and ' : ', ')} · from{' '}
                      {money(Math.min(...c.at.map((p) => p.price ?? Infinity)))}
                    </span>
                  </span>
                  <Icon name="chevron" size={18} />
                </button>
                <RowInfo name={c.sp.name} onOpen={() => setPreview(c.sp)} />
              </div>
            ))}
          </div>
          <span className="small">Not there? Look through each shop's list below, or type what's on the pack.</span>
        </div>
      )}
      {auto && auto.size === 0 && rankQ.barcode && !candidates?.length && (
        <div className="banner grey" style={{ fontSize: 13 }}>
          Restock couldn't be sure which product this is at your shops, so nothing's picked yet. Tick it at each shop
          you buy it at.
        </div>
      )}

      {sizesFor && anyResults && !changing && (
        <OtherSizesCard
          anchor={sizesFor}
          pool={sizesPool}
          skip={sizesSkip}
          picks={addingToItem ? new Map(sizesPool.filter((sp) => isPicked(keyOf(sp))).map((sp) => [keyOf(sp), sp])) : picks}
          onToggle={toggle}
          onPreview={setPreview}
          photoFor={photoFor}
          containersOn={!!settings?.otherContainerSizes}
          onContainers={(on) => void updateSettings({ otherContainerSizes: on })}
          searching={sizesBusy === sizesKey}
        />
      )}
    </>
  );
}
