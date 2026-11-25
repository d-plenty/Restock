import type { Dispatch, SetStateAction } from 'react';
import type { Settings } from '../../types';
import type { Nav } from '../nav';
import { type BarcodeInfo } from '../../lib/barcode';
import { type Chain } from '../../types';
import { type Section } from '../../shops';
import { Icon } from '../components';
import { type ForLine } from './addShared';

/** 0.15.1 (split from Add.tsx): under the results: Add manually, and More ways to add (scan several, photo, receipt, a shop's own page). */
export function AddWays(p: {
  anyResults: boolean;
  attachTo: string | undefined;
  changing: Chain | undefined;
  forLine: ForLine | undefined;
  moreWays: boolean;
  nav: Nav;
  scanned: BarcodeInfo | undefined;
  searchedFor: string | undefined;
  section: Section;
  setManual: Dispatch<SetStateAction<boolean>>;
  setMoreWays: Dispatch<SetStateAction<boolean>>;
  setPhotoFind: Dispatch<SetStateAction<boolean>>;
  settings: Settings | undefined;
}) {
  const { anyResults, attachTo, changing, forLine, moreWays, nav, scanned, searchedFor, section, setManual, setMoreWays, setPhotoFind, settings } = p;
  return (
    <>
      {/* 0.12.4: Add manually shows once you've searched or scanned (it sat on the empty screen too), as a big button under the results */}
      {(!!searchedFor || !!scanned || anyResults) && !changing && (
        <div className="add-manual">
          <span className="small">Can't find it at your shops?</span>
          <button className="btn block add-manual-btn" onClick={() => setManual(true)}>
            <Icon name="pencil" size={18} /> Add manually
          </button>
        </div>
      )}

      {/* 0.12.5: "More ways to add" is one button again, on the empty screen and under the results. It opens to the other ways in:
          by hand, several barcodes in a row, a photo of the pack, a receipt. (0.12.4 had two small links under Add manually and a receipt button.) */}
      {!forLine && !changing && (
        <div className="add-more-ways">
          <button className="btn block add-more-btn" aria-expanded={moreWays} onClick={() => setMoreWays((o) => !o)}>
            <span className="grow">More ways to add</span>
            <span className={moreWays ? 'turn-up' : 'turn-down'}>
              <Icon name="chevron" size={16} />
            </span>
          </button>
          {moreWays && (
            <div className="card flush">
              <button className="row" onClick={() => setManual(true)}>
                <Icon name="pencil" size={22} />
                <span className="grow">
                  <span className="title" style={{ fontSize: 15 }}>
                    Add manually
                  </span>
                  <span className="small">Type it in, for things your shops don't list</span>
                </span>
                <Icon name="chevron" size={16} />
              </button>
              {!attachTo && (
                <button className="row" onClick={() => nav.push({ name: 'scanned', section, start: true })}>
                  <Icon name="scan" size={22} />
                  <span className="grow">
                    <span className="title" style={{ fontSize: 15 }}>
                      Scan several barcodes
                    </span>
                    <span className="small">One after another, then match them</span>
                  </span>
                  <Icon name="chevron" size={16} />
                </button>
              )}
              {!scanned && (
                <button className="row" onClick={() => setPhotoFind(true)}>
                  <Icon name="camera" size={22} />
                  <span className="grow">
                    <span className="title" style={{ fontSize: 15 }}>
                      Find it from a photo
                    </span>
                    <span className="small">Take a picture of the pack</span>
                  </span>
                  <Icon name="chevron" size={16} />
                </button>
              )}
              {/* Shown wherever Add is opened from (the old receipt button only showed on an Add tab, which is gone) */}
              {!attachTo && !scanned && (
                <button className="row" onClick={() => nav.push(settings?.receipts.enabled ? { name: 'receipt' } : { name: 'receipts' })}>
                  <Icon name="receipt" size={22} />
                  <span className="grow">
                    <span className="title" style={{ fontSize: 15 }}>
                      Scan a receipt
                    </span>
                    <span className="small">Keep it and add what you bought</span>
                  </span>
                  <Icon name="chevron" size={16} />
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}
