import type { Dispatch, SetStateAction } from 'react';
import type { Nav } from '../nav';
import { type BarcodeInfo } from '../../lib/barcode';
import { clearRecentSearches } from '../../lib/searchHelp';
import { chainName, type Chain, type Group } from '../../types';
import { SECTION_NAMES, type Section, type StoreChain } from '../../shops';
import { Icon, TopBar } from '../components';
import { TAP, type ForLine } from './addShared';

/** The searches you made before (before anything is searched), then what this search was for. */
export function AddRecent(p: {
  anyResults: boolean;
  recent: string[];
  runText: (t: string, pressed?: boolean) => void;
  scanned: BarcodeInfo | undefined;
  searchedFor: string | undefined;
  setRecent: Dispatch<SetStateAction<string[]>>;
  setTerm: Dispatch<SetStateAction<string>>;
  term: string;
}) {
  const { anyResults, recent, runText, scanned, searchedFor, setRecent, setTerm, term } = p;
  return (
    <>
      {!anyResults && !scanned && !term && recent.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <div className="eyebrow" style={{ flex: 1 }}>
              Recent searches
            </div>
            <button
              className="linkish small"
              style={TAP}
              onClick={() => {
                clearRecentSearches();
                setRecent([]);
              }}
            >
              Clear
            </button>
          </div>
          <div className="chips">
            {recent.map((r) => (
              <button
                key={r}
                className="chip"
                onClick={() => {
                  setTerm(r);
                  runText(r);
                }}
              >
                <Icon name="search" size={14} /> {r}
              </button>
            ))}
          </div>
        </div>
      )}

      {searchedFor && anyResults && (
        <p className="small" style={{ margin: 0 }}>
          Searched for <strong>{searchedFor}</strong>.{' '}
          <button
            className="linkish"
            style={TAP}
            onClick={() => document.querySelector<HTMLInputElement>('.screen input[type="search"], .screen input.input')?.focus()}
          >
            Change it
          </button>
        </p>
      )}
    </>
  );
}

/** 0.15.1 (split from Add.tsx): the title: Pick at a shop, or the tab switcher (as on the shopping list), or the item's name. */
export function AddTitle(p: {
  altMode: boolean;
  attachGroup: Group | undefined;
  backToPicks: () => void;
  changing: Chain | undefined;
  forLine: ForLine | undefined;
  nav: Nav;
  onlyChain: StoreChain | undefined;
  overlay: boolean | undefined;
  section: Section;
  sectionsOn: Section[];
  setSwitching: Dispatch<SetStateAction<boolean>>;
  switchSection: (sec: Section) => void;
  switching: boolean;
  title: string;
}) {
  const { altMode, attachGroup, backToPicks, changing, forLine, nav, onlyChain, overlay, section, sectionsOn, setSwitching, switchSection, switching, title } = p;
  return (
    <>
      {forLine ? null : changing ? (
        // 0.12.1: "Pick one at Woolworths" is a page of its own: this title, one line, that shop's results.
        <div className="topbar">
          <button className="icon-btn" aria-label="Back" onClick={backToPicks}>
            <Icon name="back" size={20} />
          </button>
          <h1 style={{ fontSize: 24 }}>{altMode ? `Alternative at ${chainName(changing)}` : `Pick at ${chainName(changing)}`}</h1>
        </div>
      ) : !attachGroup && !onlyChain && sectionsOn.length > 1 ? (
        // 0.12.1: the title is the switcher, as on the shopping list (it was a row of buttons under the title)
        <div className="list-top navy-top navy-open">
          <div className="list-top-row add-top-row">
            {overlay && (
              <button className="icon-btn" aria-label="Back" onClick={nav.pop}>
                <Icon name="back" size={20} />
              </button>
            )}
            <button
              className="list-switch add-switch"
              aria-haspopup="menu"
              aria-expanded={switching}
              aria-label={`${title}. Tap to switch to another of your tabs`}
              onClick={() => setSwitching((x) => !x)}
            >
              <Icon name={section} size={22} />
              <span className="list-switch-name">{title}</span>
              <span className="list-switch-pill">
                Change{' '}
                <span className={switching ? 'turn-up' : 'turn-down'}>
                  <Icon name="chevron" size={16} />
                </span>
              </span>
            </button>
          </div>
          {switching && (
            <div className="list-switch-menu" role="menu" aria-label="Add to">
              {sectionsOn.map((sec) => (
                <button
                  key={sec}
                  role="menuitemradio"
                  aria-checked={sec === section}
                  className={sec === section ? 'on' : ''}
                  onClick={() => {
                    setSwitching(false);
                    switchSection(sec);
                  }}
                >
                  <Icon name={sec} size={20} />
                  <span className="grow">{SECTION_NAMES[sec]}</span>
                  {sec === section && <Icon name="check" size={18} />}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : overlay ? (
        <div className="navy-top navy-open">
          <TopBar title={title} />
        </div>
      ) : (
        <div className="navy-top navy-open">
          <h1>{title}</h1>
        </div>
      )}
    </>
  );
}
