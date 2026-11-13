import { useState, type ReactNode } from 'react';
import { AISLE_NOTE } from '../../lib/aisles';
import { nowIso, uid, updateSettings as saveNow } from '../../lib/db';
// 0.9.5 (save): on My shops, changes wait for Save settings (settingsDraft.ts); in the setup steps they're saved at once.
import { getSettings, hasUnsaved, saveDraft, updateSettings } from '../../lib/settingsDraft';
import { SaveBar, useSettingsDraft } from '../SaveBar';
import { request as askPermission } from '../../lib/permissions';
import { describePosition, findPickedShops, nearbyStores, searchArea, type Area, type NearbyStore } from '../../lib/places';
import { RestockNative } from '../../lib/sql/native';
import { asHttps, searchOnSite } from '../../lib/site';
import { useLive } from '../../lib/useLive';
import {
  BETA_SHOPS,
  chainName,
  enabledIn,
  hostOf,
  pickForTab,
  SECTION_NAMES,
  SECTION_SHOPS,
  SECTIONS,
  sectionOf,
  shopDef,
  shopsByGroup,
  type CustomShop,
  type Section,
  type ShopGroup,
  type StoreChain,
} from '../../shops';
import { adapterFor } from '../../stores';
import { colesAtStore } from '../../stores/coles';
import { isNative } from '../../stores/http';
import { forgetSearchInfo } from '../../stores/web';
import { colesStoreNo, secondBranch, storeChoice, type Settings, type ShopAccount, type StoreChoice } from '../../types';
import {
  checkWoolworths,
  openWoolworths,
  pickColesStore,
  signInColes,
  signInCostco,
  stopUsingCostco,
  signInWoolworths,
  stopUsingColes,
  stopUsingWoolworths,
} from '../../lib/accounts';
import { confirmAction } from '../../lib/confirm';
import { BETA_NOTE, BETA_SECTIONS, BetaTag, ChainDot, Icon, LoadingBar, Sheet, TopBar } from '../components';
import { useNav } from '../nav';
import { money } from '../../lib/units';
import {
  COSTCO_CANCEL,
  COSTCO_NOTICE,
  COSTCO_NOTICE_HEADING,
  COSTCO_SETTING_TITLE,
  COSTCO_SWITCH_HELP,
  COSTCO_SWITCH_HELP_ON,
  COSTCO_TURN_ON,
} from '../../lib/costcoNotice';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The word Restock searches for when testing a shop. */
import { getHealth, offerUnblock, TEST_WORD } from '../../lib/health';
import { UnblockButton } from '../Unblock';
export { TEST_WORD };

/**
 * "Find near me": every supermarket, bottle shop or pharmacy Restock knows within about 25 km,
 * grouped by shop (closest shop first), whether or not you've picked that shop yet. Choosing one as your store also
 * picks the shop, so you can set up from the list instead of ticking shops first.
 */
/**
 * Is this the branch picked as primary (or second)? By its map id when known, else by name (older
 * picks). Only for a shop that's picked: an unticked shop keeps its branch for if it's ticked again,
 * but doesn't show it as chosen. `all` is every branch in the list, for names saved by older
 * versions like "Liquorland (8.0 km)": that's the closest branch of the shop at that distance.
 */
export function isBranch(cur: StoreChoice, slot: 'primary' | 'secondary', s: NearbyStore, mine = true, all: NearbyStore[] = []): boolean {
  if (!mine) return false;
  const id = slot === 'primary' ? cur.primaryMap : cur.secondaryMap;
  if (id && (s.id || id.startsWith('@'))) return id === branchKey(s);
  const name = cur[slot];
  if (!name) return false;
  if (name === s.name) return true;
  const dist = /\((\d+(?:\.\d+)?)\s*km\)/i.exec(name)?.[1];
  if (!dist || all.some((x) => x.chain === s.chain && x.name === name)) return false;
  const at = all.filter((x) => x.chain === s.chain && km(x.km) === `${dist} km`).sort((a, b) => a.km - b.km);
  return at.length > 0 && at[0] === s;
}

/**
 * What a branch is saved by: its map id, or where it is when the map didn't give one, so it stays
 * picked when its name is tidied up afterwards (to the suburb, say).
 */
export const branchKey = (s: NearbyStore) => s.id ?? `@${s.lat.toFixed(4)},${s.lon.toFixed(4)}`;

/** "BWS (4.0 km)" and "Liquorland (8.0 km) 8.0 km", saved by older versions, read as plain names. */
export function cleanStoreName(name: string | undefined): string | undefined {
  if (!name) return name;
  return (
    name
      .replace(/\s*\(\d+(\.\d+)?\s*km\)/gi, '')
      .replace(/\s+\d+(\.\d+)?\s*km$/i, '')
      .trim() || name
  );
}

function NearbyFinder({ settings, section, only }: { settings: Settings; section: Section; only?: StoreChain }) {
  const [q, setQ] = useState('');
  const [areas, setAreas] = useState<Area[]>();
  const [stores, setStores] = useState<NearbyStore[]>();
  const [busy, setBusy] = useState<string>();
  /** How long the current search usually takes, for the loading bar. */
  const [wait, setWait] = useState<number>();
  const [error, setError] = useState<string>();
  const picked0 = enabledIn(settings.enabledChains, section, settings.shopTabs ?? {});
  // With shops picked, start with just their branches; "Everything nearby" shows the rest.
  const [onlyMine, setOnlyMine] = useState(picked0.length > 0);
  const [deep, setDeep] = useState(false);
  const [expanded, setExpanded] = useState<Set<StoreChain>>(new Set());
  const what = SECTION_SHOPS[section];
  // 0.9.9 (0.9.10): in a shop's Edit sheet, only that shop's branches.
  const picked: StoreChain[] = only ? [only] : enabledIn(settings.enabledChains, section, settings.shopTabs ?? {});

  const loadStores = async (area: Area, harder = false) => {
    setAreas(undefined);
    if (!harder) setStores(undefined);
    setExpanded(new Set());
    setBusy(
      harder
        ? `Looking up ${picked.map(chainName).join(', ')} near ${area.label} by name as well… this can take up to 30 seconds.`
        : `Finding ${what} near ${area.label}… this can take up to 20 seconds.`,
    );
    setWait(harder ? 30 : 20);
    setError(undefined);
    try {
      await saveNow({ area }); // 0.9.5 (save): where you searched isn't a setting to save
      if (harder) {
        const more = await findPickedShops(area.lat, area.lon, section, picked);
        setStores((cur) => {
          const have = new Set((cur ?? []).map((x) => x.id ?? `${x.chain}:${x.lat},${x.lon}`));
          return [...(cur ?? []), ...more.filter((x) => !have.has(x.id ?? `${x.chain}:${x.lat},${x.lon}`))];
        });
        setDeep(true);
        setOnlyMine(true);
      } else {
        const found = await nearbyStores(area.lat, area.lon, section, picked.length ? picked : undefined);
        // One shop: its branches the map knows, and the same shop looked up by name as well.
        if (only) {
          const mine = found.filter((x) => x.chain === only);
          const more = mine.length >= 2 ? [] : await findPickedShops(area.lat, area.lon, section, [only]).catch(() => [] as NearbyStore[]);
          const have = new Set(mine.map((x) => x.id ?? `${x.chain}:${x.lat},${x.lon}`));
          setStores([...mine, ...more.filter((x) => x.chain === only && !have.has(x.id ?? `${x.chain}:${x.lat},${x.lon}`))]);
        } else setStores(found);
      }
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(undefined);
      setWait(undefined);
    }
  };

  const useLocation = async () => {
    setError(undefined);
    if (!isNative()) return setError('Location works in the Android app. Search by suburb or postcode here instead.');
    setBusy('Asking for location…');
    const ok = await askPermission('location');
    if (ok !== 'granted') {
      setBusy(undefined);
      return setError("Location isn't allowed. Search by suburb or postcode instead, or allow it in Settings → Privacy and sharing → Permissions.");
    }
    setBusy('Working out roughly where you are…');
    try {
      const pos = await RestockNative.getLocation();
      const label = await describePosition(pos.lat, pos.lon);
      await loadStores({ label, lat: pos.lat, lon: pos.lon });
    } catch (e) {
      setBusy(undefined);
      setError(errText(e));
    }
  };

  const search = async () => {
    setError(undefined);
    setStores(undefined);
    setBusy('Looking up ' + q.trim() + '…');
    try {
      const found = await searchArea(q);
      if (found.length === 1) return loadStores(found[0]);
      setAreas(found);
      if (!found.length) setError(`Couldn't find "${q.trim()}". Try a suburb name or a 4-digit postcode.`);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(undefined);
    }
  };

  /** Make this branch your primary or second store, and pick its shop if it isn't already. */
  const choose = async (s: NearbyStore, slot: 'primary' | 'secondary') => {
    const latest = await getSettings();
    const cur = storeChoice(latest, s.chain);
    const next = { ...cur };
    const mapKey = slot === 'primary' ? 'primaryMap' : 'secondaryMap';
    const other = slot === 'primary' ? 'secondary' : 'primary';
    const otherMap = slot === 'primary' ? 'secondaryMap' : 'primaryMap';
    const mine = latest.enabledChains.includes(s.chain);
    const turningOff = isBranch(cur, slot, s, mine, stores);
    if (turningOff) {
      next[slot] = undefined;
      next[mapKey] = undefined;
      if (slot === 'primary') next.branchStoreNo = undefined;
      else next.branchStoreNo2 = undefined;
    } else {
      next[slot] = s.name;
      next[mapKey] = branchKey(s);
      // A new primary branch: its store number, if the map has it (else it's typed or pasted on My shops).
      if (slot === 'primary') next.branchStoreNo = s.storeNo ?? (cur.primaryMap === branchKey(s) ? cur.branchStoreNo : undefined);
      else next.branchStoreNo2 = s.storeNo ?? (cur.secondaryMap === branchKey(s) ? cur.branchStoreNo2 : undefined);
      if (isBranch(cur, other, s, true, stores)) {
        next[other] = undefined;
        next[otherMap] = undefined;
      }
    }
    await updateSettings({
      stores: { ...latest.stores, [s.chain]: next },
      enabledChains: turningOff ? latest.enabledChains : [...new Set([...latest.enabledChains, s.chain])],
    });
    // A name like "Liquorland, north-east" says little later on: look up the suburb and save that instead.
    if (!turningOff && isNative() && (/, (north|south|east|west)/.test(s.name) || / #\d+$/.test(s.name) || s.name === chainName(s.chain))) {
      try {
        const where = (await describePosition(s.lat, s.lon)).replace(/\s+[A-Z]{2,3}\s+\d{4}$/, '').trim();
        if (where) {
          const now = await getSettings();
          const c = storeChoice(now, s.chain);
          if (c[mapKey] === branchKey(s))
            await updateSettings({ stores: { ...now.stores, [s.chain]: { ...c, [slot]: `${chainName(s.chain)} ${where}` } } });
        }
      } catch {
        // keep the name it has
      }
    }
  };

  const list = (stores ?? []).filter((s) => (only ? s.chain === only : !onlyMine || !picked.length || picked.includes(s.chain)));
  const label = only ? chainName(only) : SECTION_NAMES[section] === 'Pantry' ? 'supermarkets' : what;

  return (
    <div className="card">
      <div className="title">{only ? `${label} near you` : `Your nearest ${label}`}</div>
      <p className="small" style={{ marginTop: -4 }}>
        Tap <strong>Primary</strong> on the branch you usually go to, and <strong>2nd</strong> on another if you have one. Picking a branch also picks
        its shop.
      </p>
      <button className="btn primary" onClick={useLocation} disabled={!!busy}>
        <Icon name="pin" size={18} /> Find {label} near me
      </button>
      {
        <form
          style={{ display: 'flex', gap: 8 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (q.trim()) void search();
          }}
        >
          <input
            className="input"
            placeholder="Or type a suburb or postcode"
            aria-label="Suburb or postcode"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <button className="btn" type="submit" aria-label="Search" style={{ width: 52, minWidth: 52, flexShrink: 0, padding: 0 }} disabled={!!busy}>
            <Icon name="search" />
          </button>
        </form>
      }
      {!stores && !busy && !areas && settings.area && (
        <button className="btn ghost small" onClick={() => loadStores(settings.area!)}>
          Show {label} near {settings.area.label.replace(/\s+[A-Z]{2,3}\s+\d{4}$/, '')}
        </button>
      )}
      {busy && (
        <div style={{ display: 'grid', gap: 8 }}>
          <p className="small" role="status">
            {busy}
          </p>
          <LoadingBar key={busy} seconds={wait ?? 6} />
        </div>
      )}
      {error && (
        <div className="banner amber" style={{ fontSize: 13 }}>
          {error}
        </div>
      )}

      {areas && areas.length > 0 && (
        <div className="card flush" style={{ boxShadow: 'none' }}>
          {areas.map((a) => (
            <button key={a.label + a.lat} className="row" onClick={() => loadStores(a)}>
              <Icon name="pin" size={18} />
              <span className="grow title" style={{ fontSize: 15 }}>
                {a.label}
              </span>
              <Icon name="chevron" size={18} />
            </button>
          ))}
        </div>
      )}

      {stores && !busy && (
        <>
          <span className="small">
            {stores.length
              ? `${list.length} ${onlyMine && picked.length ? `of your ${label}` : label} near ${(settings.area?.label ?? 'you').replace(/\s+[A-Z]{2,3}\s+\d{4}$/, '')}, closest first.`
              : `No ${label} Restock knows within 25 km of ${settings.area?.label ?? 'there'}.`}
          </span>
          {!only && picked.length > 0 && stores.length > 0 && (
            <div className="seg" role="radiogroup" aria-label="Which branches">
              <button role="radio" aria-checked={onlyMine} className={onlyMine ? 'on' : ''} onClick={() => setOnlyMine(true)}>
                My shops
              </button>
              <button role="radio" aria-checked={!onlyMine} className={!onlyMine ? 'on' : ''} onClick={() => setOnlyMine(false)}>
                Everything nearby
              </button>
            </div>
          )}
          {byShop(list).map(({ chain, branches }) => {
            const open = expanded.has(chain);
            const shownBranches = open ? branches : branches.slice(0, 3);
            const mine = picked.includes(chain);
            return (
              <div key={chain} className="near-group">
                <div className="near-head">
                  <ChainDot chain={chain} />
                  <span className="grow">
                    <span className="title" style={{ fontSize: 15 }}>
                      {chainName(chain)}
                      {mine && (
                        <span className="tag normal" style={{ marginLeft: 8 }}>
                          PICKED
                        </span>
                      )}
                    </span>
                    <span className="small">
                      {branches.length} nearby · closest {km(branches[0].km)}
                    </span>
                  </span>
                </div>
                {shownBranches.map((s) => {
                  const cur = storeChoice(settings, s.chain);
                  return (
                    <div key={s.id ?? s.name + s.lat} className="row near-branch">
                      <span className="grow" style={{ flex: '1 1 170px', minWidth: 0 }}>
                        <span className="title" style={{ fontSize: 15 }}>
                          {cleanStoreName(s.name)}
                        </span>
                        <span className="small">
                          {km(s.km)}
                          {s.address ? ` · ${s.address}` : ''}
                        </span>
                        {s.note && <span className="small">{s.note}</span>}
                      </span>
                      <span className="store-pick" style={{ marginLeft: 'auto' }}>
                        <button
                          className="chip"
                          aria-pressed={isBranch(cur, 'primary', s, mine, stores)}
                          onClick={() => choose(s, 'primary')}
                          aria-label={`Make ${s.name} your main branch`}
                        >
                          Primary
                        </button>
                        <button
                          className="chip"
                          aria-pressed={isBranch(cur, 'secondary', s, mine, stores)}
                          onClick={() => choose(s, 'secondary')}
                          aria-label={`Make ${s.name} your second branch`}
                        >
                          2nd
                        </button>
                      </span>
                    </div>
                  );
                })}
                {branches.length > 3 && (
                  <button
                    className="linkish small"
                    style={{ alignSelf: 'flex-start', padding: '6px 0' }}
                    onClick={() =>
                      setExpanded((x) => {
                        const n = new Set(x);
                        if (open) n.delete(chain);
                        else n.add(chain);
                        return n;
                      })
                    }
                  >
                    {open ? `Show fewer ${chainName(chain)}` : `Show ${branches.length - 3} more ${chainName(chain)}`}
                  </button>
                )}
              </div>
            );
          })}
          {picked.length > 0 && !deep && settings.area && (
            <button
              className="linkish small"
              style={{ alignSelf: 'flex-start' }}
              onClick={() => void loadStores(settings.area!, true)}
              disabled={!!busy}
            >
              Can't see your branch? Look up {picked.length === 1 ? chainName(picked[0]) : 'your shops'} by name too
            </button>
          )}
          <p className="small">
            Shop locations © OpenStreetMap contributors. Independent shops without a chain name aren't listed; add their website with "Other"
            instead.
          </p>
        </>
      )}
    </div>
  );
}

const km = (n: number) => `${n < 10 ? n.toFixed(1) : Math.round(n)} km`;

/** Branches grouped by shop: the shop with the closest branch first, and each shop's branches closest first. */
export function byShop(stores: NearbyStore[]): { chain: StoreChain; branches: NearbyStore[] }[] {
  const groups = new Map<StoreChain, NearbyStore[]>();
  for (const s of [...stores].sort((a, b) => a.km - b.km)) groups.set(s.chain, [...(groups.get(s.chain) ?? []), s]);
  return [...groups.entries()].map(([chain, branches]) => ({ chain, branches }));
}

/** 0.10.3: pick a shop for one tab, or take it off that tab (it stays on any other tab it's on). */
async function setShopFor(chain: StoreChain, section: Section, on: boolean) {
  const s = await getSettings();
  await updateSettings(pickForTab(s, chain, section, on));
}

/** What the tab's shops are called in the picker's heading. */
const TAB_SHOPS_TITLE: Record<Section, string> = {
  pantry: 'Shops for Pantry',
  keg: 'Shops for Keg',
  pharmacy: 'Shops for Health',
  baby: 'Shops for Baby',
  pets: 'Shops for Pets',
};
/** The heading each tab opens with (the rest start folded away). */
const TAB_GROUP: Record<Section, ShopGroup> = { pantry: 'supermarket', keg: 'bottle', pharmacy: 'pharmacy', baby: 'baby', pets: 'pet' };

/**
 * 0.10.3: every shop Restock knows, under headings (Supermarkets, Chemists, Bottle shops, Baby
 * shops, Pet shops, Big box stores, Other shops), on every tab's page: tick the ones this tab
 * searches. A shop can be on more than one tab (Woolworths for Pantry and for Baby); its branch is
 * the same on each. Nothing is ticked to start with. Under a ticked shop: its status and Edit.
 */
export function ShopPicker({ settings, section }: { settings: Settings; section: Section }) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<CustomShop>();
  const [costco, setCostco] = useState(false);
  const picked = enabledIn(settings.enabledChains, section, settings.shopTabs ?? {});
  const groups = shopsByGroup();
  const tick = (id: StoreChain, on: boolean) => {
    // Costco asks first, once (its notice), as before.
    if (id === 'costco' && on && !settings.costco?.acceptedAt) return setCostco(true);
    void setShopFor(id, section, on);
  };
  return (
    <>
      {groups.map((g) => {
        const here = g.shops.filter((x) => picked.includes(x.id));
        return (
          <details
            key={g.group}
            className="dropdown card flush shop-group"
            open={g.group === TAB_GROUP[section] || here.length > 0 || undefined}
          >
            <summary className="row">
              <span className="grow">
                <span className="title" style={{ fontSize: 15 }}>
                  {g.name}
                </span>
                <span className="small clip">{here.length ? `${here.length} picked: ${here.map((x) => x.name).join(', ')}` : `${g.shops.length} ${g.shops.length === 1 ? 'shop' : 'shops'}`}</span>
              </span>
              <Icon name="chevron" size={18} />
            </summary>
            {g.shops.map((shop) => {
              const on = picked.includes(shop.id);
              const def = shopDef(shop.id);
              return (
                <div key={shop.id}>
                  <label className="check">
                    <input type="checkbox" checked={on} onChange={(e) => tick(shop.id, e.target.checked)} aria-label={`Use ${shop.name} for ${SECTION_NAMES[section]}`} />
                    <ChainDot chain={shop.id} />
                    <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                      <span>
                        {shop.name} {BETA_SHOPS.includes(shop.id) && <BetaTag />}
                      </span>
                      {shop.id === 'costco' ? (
                        <span className="small">{on ? COSTCO_SWITCH_HELP_ON : COSTCO_SWITCH_HELP}</span>
                      ) : (
                        shop.note && <span className="small">{shop.note}</span>
                      )}
                      {on && <span className="small">{branchText(storeChoice(settings, shop.id), shop.id)}</span>}
                    </span>
                    {shop.custom && (
                      <button
                        type="button"
                        className="btn small ghost"
                        onClick={(e) => {
                          e.preventDefault();
                          setEditing(settings.customShops.find((c) => c.id === shop.id));
                        }}
                      >
                        Edit
                      </button>
                    )}
                  </label>
                  {on && def?.pickOnSite && <PickOnSite chain={shop.id} />}
                  {on && <ShopEdit settings={settings} chain={shop.id} />}
                </div>
              );
            })}
            {g.group === 'other' && (
              <button className="row" onClick={() => setAdding(true)}>
                <Icon name="plus" size={18} />
                <span className="grow">
                  <span className="title" style={{ fontSize: 15 }}>
                    Add your own shop
                  </span>
                  <span className="small">Any shop with prices on its website: give it a name and its website, and Restock reads its search page.</span>
                </span>
              </button>
            )}
          </details>
        );
      })}
      {(adding || editing) && <CustomShopSheet section={section} shop={editing} onClose={() => (setAdding(false), setEditing(undefined))} />}
      {costco && <CostcoAsk section={section} onClose={() => setCostco(false)} />}
    </>
  );
}

/** 0.10.3 (IGA): its prices are the store picked on its own website, so that's where you pick it. */
function PickOnSite({ chain }: { chain: StoreChain }) {
  const def = shopDef(chain);
  const [done, setDone] = useState(false);
  if (!def?.pickOnSite) return null;
  return (
    <div className="shop-extra">
      <span className="small">
        {done ? `Done. Restock now uses the store you picked on ${chainName(chain)}'s website.` : `${chainName(chain)}'s prices are each store's own: pick yours on its website.`}
      </span>
      <button
        className="btn small"
        disabled={!isNative()}
        onClick={async () => {
          await RestockNative.openStore({ chain, message: def.pickOnSite });
          setDone(true);
        }}
      >
        {isNative() ? `Choose your ${chainName(chain)} store` : 'Works in the Android app'}
      </button>
    </div>
  );
}

/** Add or edit a shop of your own: a name and a website, tested before saving. */
export function CustomShopSheet({ section, shop, onClose }: { section: Section; shop?: CustomShop; onClose: () => void }) {
  const [name, setName] = useState(shop?.name ?? '');
  const [site, setSite] = useState(shop?.website ?? '');
  const [searchAt, setSearchAt] = useState(shop?.search ?? '');
  const [test, setTest] = useState<{ busy?: boolean; ok?: boolean; text?: string; samples?: string[] }>();

  const website = (() => {
    const t = site.trim();
    if (!t) return '';
    const withScheme = /^https?:\/\//i.test(t) ? t : `https://${t}`;
    // 0.9.0: always https (an http:// address is moved to https).
    const u = asHttps(withScheme);
    return u ? `https://${u.host}` : '';
  })();
  // 0.9.0: the search page has to be on the shop's own site (site.ts), with {q} in it.
  const search = searchAt.trim() ? (searchOnSite(searchAt, website) ?? '') : '';
  const searchProblem = !searchAt.trim()
    ? undefined
    : !searchAt.includes('{q}')
      ? `Put {q} where the search word goes.`
      : !search
        ? `The search page has to be on ${website ? hostOf(website) : 'the shop’s website'}.`
        : undefined;
  const valid = !!name.trim() && !!website && (!searchAt.trim() || !!search);

  /** Save (so the shop exists to test), then search it for the test word. */
  const save = async (andTest: boolean) => {
    const s = await getSettings();
    const id = shop?.id ?? (`custom-${uid().slice(0, 8)}` as const);
    const next: CustomShop = { id, name: name.trim(), website, section, search: search || undefined, createdAt: shop?.createdAt ?? nowIso() };
    const changedSite = !shop || shop.website !== website || shop.search !== next.search;
    await updateSettings({
      customShops: [...s.customShops.filter((c) => c.id !== id), next],
      enabledChains: [...new Set([...s.enabledChains, id])],
    });
    if (changedSite) await forgetSearchInfo(id).catch(() => undefined);
    if (!andTest) return onClose();
    setTest({ busy: true });
    try {
      const items = await adapterFor(id)!.search(TEST_WORD[section]);
      setTest({
        ok: items.length > 0,
        text: items.length
          ? `Working: found ${items.length} products for "${TEST_WORD[section]}".`
          : `Saved, but no products came back for "${TEST_WORD[section]}". If the site has a search page, search it for "${TEST_WORD[section]}" in your browser, then paste that page's address below with {q} where the word was.`,
        // 0.9.0: a result without a price shows just its name (not "$undefined").
        samples: items.slice(0, 3).map((p) => (typeof p.price === 'number' ? `${p.name} · ${money(p.price)}` : p.name)),
      });
    } catch (e) {
      setTest({ ok: false, text: `Saved, but the test didn't work: ${errText(e)}` });
    }
  };

  const remove = async () => {
    if (!shop) return onClose();
    const s = await getSettings();
    await updateSettings({ customShops: s.customShops.filter((c) => c.id !== shop.id), enabledChains: s.enabledChains.filter((c) => c !== shop.id) });
    onClose();
  };

  return (
    <Sheet
      title={shop ? `Edit ${shop.name}` : `Add a ${section === 'keg' ? 'bottle shop' : section === 'pharmacy' ? 'pharmacy' : 'shop'}`}
      onClose={onClose}
    >
      <p className="small">
        Restock opens the shop's website the same way your browser does, finds its search page and reads the products and prices on it. It only ever
        searches this shop for things on your {SECTION_NAMES[section]} tab.
      </p>
      <label className="field">
        <span>Name</span>
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={section === 'keg' ? 'e.g. Local Bottle Shop' : 'e.g. Corner Chemist'}
        />
      </label>
      <label className="field">
        <span>Website</span>
        <input
          className="input"
          inputMode="url"
          autoCapitalize="off"
          value={site}
          onChange={(e) => setSite(e.target.value)}
          placeholder="e.g. www.example.com.au"
        />
        {site.trim() && !website && (
          <span className="small" style={{ color: 'var(--red-ink)' }}>
            That doesn't look like a website address.
          </span>
        )}
      </label>
      <details className="explain">
        <summary>
          <Icon name="pencil" size={18} />
          <span>Advanced: the search page</span>
        </summary>
        <div className="explain-body">
          <p className="small">
            Usually found automatically. If not, search the shop's site for anything, copy the results page's address, and put {'{q}'} where your
            search word was. For example: https://www.example.com.au/search?q={'{q}'}
          </p>
          <input
            className="input"
            inputMode="url"
            autoCapitalize="off"
            value={searchAt}
            onChange={(e) => setSearchAt(e.target.value)}
            placeholder="https://…/search?q={q}"
          />
          {searchProblem && (
            <span className="small" style={{ color: 'var(--red-ink)' }}>
              {searchProblem}
            </span>
          )}
        </div>
      </details>
      {test && (
        <div
          className={`banner ${test.busy ? 'grey' : test.ok ? 'green' : 'amber'}`}
          style={{ fontSize: 13, flexDirection: 'column', alignItems: 'flex-start' }}
          role="status"
        >
          <span>{test.busy ? `Searching ${name.trim() || 'the shop'} for "${TEST_WORD[section]}"…` : test.text}</span>
          {test.samples?.map((x) => (
            <span key={x} className="small">
              {x}
            </span>
          ))}
        </div>
      )}
      {!isNative() && <p className="small">Testing works in the Android app.</p>}
      <div className="two">
        <button className="btn" disabled={!valid || test?.busy} onClick={() => void save(true)}>
          Save and test
        </button>
        <button className="btn primary" disabled={!valid || test?.busy} onClick={() => (test?.text ? onClose() : void save(false))}>
          {test?.text ? 'Done' : 'Save'}
        </button>
      </div>
      {shop && (
        <button className="btn ghost" style={{ color: 'var(--red-ink)' }} onClick={() => void remove()}>
          Remove {shop.name}
        </button>
      )}
    </Sheet>
  );
}

/** Switch the Keg or Pharmacy tab on or off. Keg asks once that you're 18 or over. */
/** 0.10.3: each tab's switch, what it's for, and its line in setup and Settings. */
const TAB_ABOUT: Record<Exclude<Section, 'pantry'>, { title: string; text: string; seldom: string }> = {
  keg: {
    title: 'Bottle shops (Keg tab)',
    text: 'Track beer, wine and spirits prices at the shops you pick. Kept separate from groceries.',
    seldom: 'a drink',
  },
  pharmacy: {
    title: 'Chemists (Health tab)',
    text: 'Track medicine, first aid and personal care prices at the shops you pick. Kept separate from groceries.',
    seldom: 'from a chemist',
  },
  baby: {
    title: 'Baby tab',
    text: 'Track nappies, wipes, formula and baby things at the shops you pick: Baby Bunting, chemists, Big W, supermarkets.',
    seldom: 'baby things',
  },
  pets: {
    title: 'Pets tab',
    text: 'Track pet food, litter and treats at the shops you pick: pet shops, supermarkets, Bunnings.',
    seldom: 'for a pet',
  },
};

export function SectionSwitch({ settings, section }: { settings: Settings; section: Exclude<Section, 'pantry'> }) {
  const [askAge, setAskAge] = useState(false);
  const on = !!settings.sections[section];
  const about = TAB_ABOUT[section];
  const turn = async (v: boolean) => {
    if (v && section === 'keg' && !settings.adultConfirmed) return setAskAge(true);
    await updateSettings({ sections: { ...settings.sections, [section]: v } });
  };
  return (
    <>
      <div className="card flush">
        <label className="check tab-switch">
          <Icon name={section} size={22} />
          <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            <span className="title" style={{ fontSize: 15 }}>
              {about.title} <BetaTag />
            </span>
            <span className="small">{about.text}</span>
          </span>
          <input type="checkbox" className="switch" checked={on} onChange={(e) => void turn(e.target.checked)} aria-label={`Use the ${SECTION_NAMES[section]} tab`} />
        </label>
        {on && (
          <label className="check" style={{ borderTop: '1px solid var(--line)' }}>
            <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
              <span className="title" style={{ fontSize: 15 }}>
                Show {SECTION_NAMES[section]} in More
              </span>
              <span className="small">
                Turn this off if you only buy {about.seldom} now and then. You can still search these shops on Add and put things on your
                shopping list without tracking them.
              </span>
            </span>
            <input
              type="checkbox" className="switch"
              checked={!settings.hiddenTabs?.includes(section)}
              onChange={(e) =>
                void updateSettings({
                  hiddenTabs: e.target.checked
                    ? (settings.hiddenTabs ?? []).filter((x) => x !== section)
                    : [...new Set([...(settings.hiddenTabs ?? []), section])],
                })
              }
              aria-label={`Show ${SECTION_NAMES[section]} in More`}
            />
          </label>
        )}
      </div>
      {askAge && (
        <Sheet title="Bottle shops are 18+" onClose={() => setAskAge(false)}>
          <p>The Keg tab tracks alcohol prices. Please confirm you're 18 or over.</p>
          <div className="two">
            <button className="btn" onClick={() => setAskAge(false)}>
              Not yet
            </button>
            <button
              className="btn primary"
              onClick={async () => {
                await updateSettings({ adultConfirmed: true, sections: { ...settings.sections, keg: true } });
                setAskAge(false);
              }}
            >
              I'm 18 or over
            </button>
          </div>
        </Sheet>
      )}
    </>
  );
}

/** Store names typed by hand, for shops not on the map (or to name a branch differently). */
function ManualNames({ settings, section }: { settings: Settings; section: Section }) {
  const chains = enabledIn(settings.enabledChains, section, settings.shopTabs ?? {});
  const setStore = async (chain: StoreChain, key: 'primary' | 'secondary' | 'storeId', value: string) => {
    const latest = await getSettings();
    await updateSettings({ stores: { ...latest.stores, [chain]: { ...storeChoice(latest, chain), [key]: value || undefined } } });
  };
  if (!chains.length) return null;
  return (
    <details className="explain">
      <summary>
        <Icon name="pencil" size={18} />
        <span>Enter a branch yourself</span>
      </summary>
      <div className="explain-body">
        {chains.map((chain) => {
          const s = storeChoice(settings, chain);
          return (
            <div key={chain} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div className="eyebrow" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <ChainDot chain={chain} /> {chainName(chain)}
              </div>
              <div className="two">
                <input
                  key={`p-${s.primary ?? ''}`}
                  className="input"
                  placeholder="Main branch"
                  aria-label={`${chainName(chain)} main branch`}
                  defaultValue={s.primary ?? ''}
                  onBlur={(e) => void setStore(chain, 'primary', e.target.value.trim())}
                />
                <input
                  key={`s-${s.secondary ?? ''}`}
                  className="input"
                  placeholder="Second (optional)"
                  aria-label={`${chainName(chain)} second branch`}
                  defaultValue={s.secondary ?? ''}
                  onBlur={(e) => void setStore(chain, 'secondary', e.target.value.trim())}
                />
              </div>
              {chain === 'coles' && (
                <input
                  className="input"
                  inputMode="numeric"
                  placeholder="Advanced: Coles branch number (4 digits)"
                  aria-label="Coles branch number"
                  defaultValue={s.storeId ?? ''}
                  onBlur={(e) => void setStore(chain, 'storeId', e.target.value.trim())}
                />
              )}
            </div>
          );
        })}
      </div>
    </details>
  );
}

/** Everything about one tab's shops: which ones, your nearest branches, and names typed by hand. */
export function StoreFields({ settings, section = 'pantry' }: { settings: Settings; section?: Section; inSetup?: boolean }) {
  const on = section === 'pantry' || !!settings.sections[section];
  return (
    <>
      {section !== 'pantry' && <SectionSwitch settings={settings} section={section} />}
      {on && (
        <>
          <div className="eyebrow">1 · {TAB_SHOPS_TITLE[section]}</div>
          <p className="small" style={{ margin: 0 }}>
            Tick the shops {section === 'pantry' ? 'your Pantry' : `the ${SECTION_NAMES[section]} tab`} searches and compares. Every shop is here, so
            you can mix them: a shop can be on more than one tab, with the same branch.
          </p>
          <ShopPicker settings={settings} section={section} />
          {!enabledIn(settings.enabledChains, section, settings.shopTabs ?? {}).length && (
            <p className="small" role="status">
              {section === 'pantry' ? 'Pick at least one shop for your Pantry.' : `Pick at least one shop to show the ${SECTION_NAMES[section]} tab.`}
            </p>
          )}
          <div className="eyebrow">2 · Your branches</div>
          {/* Keyed by tab only: picking a shop or a branch must not throw away the list you're looking at. */}
          <NearbyFinder key={section} settings={settings} section={section} />
          <ManualNames settings={settings} section={section} />
          {section === 'pantry' ? (
            <AisleCard settings={settings} />
          ) : (
            <p className="small">
              Prices come from each shop's website, so they're the online price.
              {section === 'pharmacy'
                ? ' Some chemists only show prices in the shop, or set them per branch; those may come up with nothing.'
                : section === 'keg'
                  ? ' Some bottle shops set prices per branch, so your local one can differ.'
                  : ' Some shops set prices per branch, so your local one can differ.'}{' '}
              In shopping mode their things show Aisle: unknown unless the shop gives aisle numbers.
            </p>
          )}
        </>
      )}
    </>
  );
}

/**
 * 0.9.12: Aldi's price is the same at every branch, so its branch only names where you go in Start
 * shopping: it's optional, not something missing.
 */
const NO_BRANCH_YET = (chain: StoreChain) => (chain === 'aldi' ? 'Branch optional: it only names where you go in Start shopping' : 'No branch picked yet');

/** "Your store: Kirwan · 2nd: Upper Ross", or that no branch is picked yet. */
function branchText(st: StoreChoice, chain: StoreChain): string {
  const primary = cleanStoreName(st.primary);
  const second = cleanStoreName(st.secondary);
  if (!primary && !second) return NO_BRANCH_YET(chain);
  return [primary && `Your branch: ${primary}`, second && `2nd: ${second}`].filter(Boolean).join(' · ');
}

export function StoresScreen({ section = 'pantry' }: { section?: Section }) {
  useSettingsDraft(); // 0.9.5 (save)
  const settings = useLive(getSettings, []);
  const nav = useNav();
  const [tab, setTab] = useState<Section>(section);
  return (
    <div className="screen">
      <TopBar title="My shops" />
      <div className="seg shop-tabs" role="tablist" aria-label="Which shops">
        {SECTIONS.map((sec) => (
          <button key={sec} role="tab" aria-selected={sec === tab} className={sec === tab ? 'on' : ''} onClick={() => setTab(sec)}>
            <Icon name={sec} size={17} /> {SECTION_NAMES[sec]}
          </button>
        ))}
      </div>
      {BETA_SECTIONS.includes(tab) && <p className="small" style={{ margin: 0 }}>{BETA_NOTE}</p>}
      {settings && <StoreFields key={tab} settings={settings} section={tab} />}
      {settings && (
        <button
          className="btn primary block"
          onClick={async () => {
            // 0.9.5 (save): Done saves what's changed, then goes back.
            const changed = hasUnsaved();
            if (changed && !(await saveDraft())) return;
            const label = tab === 'pantry' ? 'Pantry shops' : `${SECTION_NAMES[tab]} shops`;
            const summary = shopSummary(settings, tab);
            if (changed) nav.toast(summary === 'Off' ? `${label} are off.` : `${label} saved: ${summary}`);
            nav.pop();
          }}
        >
          <Icon name="check" size={18} /> Done
        </button>
      )}
      <SaveBar />
    </div>
  );
}

/**
 * 0.10.2: where aisle numbers come from (setup and Settings → Supermarkets), with the disclaimer.
 * Only Coles gives them, at your branch, with Prices and stock at my store on.
 */
function AisleCard({ settings }: { settings: Settings }) {
  const coles = settings.enabledChains.includes('coles');
  const branch = !!(settings.localPrices && storeChoice(settings, 'coles').branchStoreNo);
  return (
    <>
      <div className="eyebrow" id="s-aisles">
        Aisle numbers
      </div>
      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <p className="small" style={{ margin: 0 }}>
          When you start shopping, each thing shows its aisle at your branch, and you can sort each shop by aisle, category or A–Z. Where a shop
          doesn't say, it shows Aisle: unknown.
        </p>
        <p className="small" style={{ margin: 0, fontWeight: 600 }}>
          {AISLE_NOTE}
        </p>
        <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
          <li>
            Coles:{' '}
            {!coles
              ? 'gives aisle numbers for most things, once you pick it.'
              : branch
                ? `yes, at ${storeChoice(settings, 'coles').primary ?? 'your branch'}${secondBranch(settings) ? ` and ${secondBranch(settings)}` : ''}, from the next price check.`
                : 'turn on Prices and stock at my store (under Coles, above) and set your branch.'}
          </li>
          <li>Woolworths: its website gives an online category, not an aisle number.</li>
          <li>Aldi and Costco: they don't publish aisle numbers.</li>
          <li>IGA and the other shops: Aisle: unknown for now.</li>
        </ul>
      </div>
    </>
  );
}

/** One line for Settings: which shops each tab uses. */
export function shopSummary(settings: Settings, section: Section): string {
  if (section !== 'pantry' && !settings.sections[section]) return 'Off';
  const chains = enabledIn(settings.enabledChains, section, settings.shopTabs ?? {});
  if (!chains.length) return section === 'pantry' ? 'None picked' : 'On, but no shops picked yet';
  return chains
    .map((c) => {
      const s = storeChoice(settings, c);
      return s.primary && shopDef(c) ? `${chainName(c)} (${cleanStoreName(s.primary)})` : chainName(c);
    })
    .join(', ');
}

/** A shop's account card: its name, one status line, one main button, and the details behind ⓘ. */
function AccountCard({
  chain,
  beta,
  status,
  ok,
  info,
  children,
  inlineShop,
}: {
  inlineShop?: boolean;
  chain: 'woolworths' | 'coles';
  beta?: boolean;
  status: string;
  ok: boolean;
  info: { title: string; body: ReactNode };
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  // 0.9.8: under the shop's own tick in the supermarket list: its status, "About <shop>", then its buttons.
  if (inlineShop)
    return (
      <div className="shop-extra">
        <span className="small" style={{ color: ok ? 'var(--green-ink)' : 'var(--ink-2)' }}>
          {status}
          {beta && <span className="tag normal" style={{ marginLeft: 6 }}>BETA</span>}
        </span>
        <details className="explain">
          <summary>
            <Icon name="info" size={18} />
            <span>About {chainName(chain)}: signed in or not</span>
          </summary>
          <div className="explain-body">{info.body}</div>
        </details>
        {children}
      </div>
    );
  return (
    <div className="woolies-account">
      <div className="row" style={{ padding: 0, minHeight: 0, gap: 10 }}>
        <ChainDot chain={chain} />
        <span className="grow" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span className="title" style={{ fontSize: 15, display: 'flex', gap: 6, alignItems: 'center' }}>
            {chainName(chain)} {beta && <span className="tag normal">BETA</span>}
          </span>
          <span className="small" style={{ color: ok ? 'var(--green-ink)' : 'var(--ink-2)' }}>
            {status}
          </span>
        </span>
        <button className="info-btn" onClick={() => setOpen(true)} aria-label={info.title}>
          <Icon name="info" size={20} />
        </button>
      </div>
      {children}
      {open && (
        <Sheet title={info.title} onClose={() => setOpen(false)}>
          {info.body}
        </Sheet>
      )}
    </div>
  );
}

/**
 * Woolworths: sign in (your store's prices and stock, and your list straight into your trolley) or
 * don't (online prices, no stock). You sign in on Woolworths' own page inside Restock, so your
 * password goes to Woolworths, never to Restock.
 */
function WoolworthsAccount({ settings, inline }: { settings: Settings; inline?: boolean }) {
  const acct = settings.accounts?.woolworths;
  const [busy, setBusy] = useState<string>();
  const [note, setNote] = useState<{ ok: boolean; text: string }>();
  const go = async (what: string, fn: () => Promise<ShopAccount | void>) => {
    setBusy(what);
    setNote(undefined);
    try {
      const a = await fn();
      if (a)
        setNote(
          a.signedIn
            ? a.storeId
              ? { ok: true, text: `Signed in. Your store: ${a.storeName ?? `Woolworths store ${a.storeId}`}.` }
              : { ok: false, text: 'Signed in, but no branch is picked yet. Tap "Change branch", choose Pick up and your local shop, then tap Done.' }
            : { ok: false, text: "Woolworths says you're not signed in. Try again, and tap Done once you're in." },
        );
    } catch (e) {
      setNote({ ok: false, text: errText(e) });
    } finally {
      setBusy(undefined);
    }
  };
  const on = !!acct?.signedIn;
  return (
    <AccountCard
      inlineShop={inline}
      chain="woolworths"
      ok={on && !!acct?.storeId}
      status={
        on
          ? acct?.storeId
            ? `Signed in · prices and stock at ${acct.storeName ?? `store ${acct.storeId}`}`
            : 'Signed in · no branch picked yet'
          : 'Not signed in · online prices only, no stock'
      }
      info={{
        title: 'Woolworths sign-in',
        body: (
          <>
            <p className="small">
              <strong>Signed in:</strong> your own branch's prices and stock, and you can send your shopping list straight into your Woolworths
              trolley.
            </p>
            <p className="small">
              <strong>Not signed in:</strong> Woolworths' online prices. No stock is shown, as online stock isn't reliable for your branch.
            </p>
            <p className="small">
              You sign in on Woolworths' own page, so your password goes to Woolworths, not Restock. Restock then asks the Woolworths website for
              prices as you, and adds to your trolley only when you tap Send. Woolworths may not allow apps to do this, and it may stop working if
              they change their website.
            </p>
          </>
        ),
      }}
    >
      {on ? (
        <div className="chips" style={{ flexWrap: 'wrap' }}>
          <button
            className="btn small"
            disabled={!!busy}
            onClick={() =>
              void go(
                'store',
                async () => (await openWoolworths('Choose Pick up and your local shop at the top of the page. Then tap Done.'), checkWoolworths()),
              )
            }
          >
            Change branch
          </button>
          <button className="btn small" disabled={!!busy} onClick={() => void go('check', checkWoolworths)}>
            {busy === 'check' ? 'Checking…' : 'Check again'}
          </button>
          <button className="btn small ghost" disabled={!!busy} onClick={() => void go('stop', stopUsingWoolworths)}>
            Sign out
          </button>
        </div>
      ) : (
        <button className="btn primary" disabled={!!busy || !isNative()} onClick={() => void go('in', signInWoolworths)}>
          {busy === 'in' ? 'Checking…' : isNative() ? 'Sign in to Woolworths' : 'Sign in works in the Android app'}
        </button>
      )}
      {note && (
        <div className={`banner ${note.ok ? 'green' : 'amber'}`} style={{ fontSize: 13 }}>
          {note.text}
        </div>
      )}
    </AccountCard>
  );
}

/**
 * Coles: your own store's prices and stock come from its store number. "Choose your Coles store"
 * opens Coles' store finder and picks the number up from the store's page by itself (0.7.2); the
 * map fills it in too when it knows it, and typing it is a fallback. Signing in is only for
 * filling your Coles trolley, which Restock hasn't learned yet.
 */
function ColesStore({ settings, inline }: { settings: Settings; inline?: boolean }) {
  const nav = useNav();
  const st = storeChoice(settings, 'coles');
  const on = !!(settings.localPrices && st.branchStoreNo);
  const signedIn = !!settings.accounts?.coles?.signedIn;
  const [texts, setTexts] = useState<Record<'branchStoreNo' | 'branchStoreNo2', string>>({
    branchStoreNo: st.branchStoreNo ?? '',
    branchStoreNo2: st.branchStoreNo2 ?? '',
  });
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<{ busy?: boolean; text?: string; ok?: boolean }>({});
  const runTest = async () => {
    const no = storeChoice(await getSettings(), 'coles').branchStoreNo;
    if (!no) return;
    setTest({ busy: true });
    try {
      const found = await colesAtStore('milk', no);
      setTest(
        found.length
          ? { ok: true, text: `Coles answered for branch ${no}: ${found.length} products for "milk", with your branch's prices and stock.` }
          : { ok: false, text: `Coles answered for branch ${no} but found nothing. Check the branch number.` },
      );
    } catch (e) {
      setTest({
        ok: false,
        text: isNative()
          ? `Coles didn't answer for branch ${no} (${errText(e)}). Restock will use its online prices until it does.`
          : 'Testing works in the Android app.',
      });
    }
  };
  const save = async (slot: 'primary' | 'secondary', no: string | undefined, name?: string) => {
    const latest = await getSettings();
    const cur = storeChoice(latest, 'coles');
    const key = slot === 'primary' ? 'branchStoreNo' : 'branchStoreNo2';
    const next: StoreChoice = { ...cur, [key]: no };
    // A store picked on Coles' own site replaces a different branch picked on the map.
    if (name && cur[slot] !== name) {
      next[slot] = name;
      if (slot === 'primary') next.primaryMap = undefined;
      else next.secondaryMap = undefined;
    }
    setTexts((t) => ({ ...t, [key]: no ?? '' }));
    await updateSettings({ stores: { ...latest.stores, coles: next }, ...(no && slot === 'primary' ? { localPrices: true } : {}) });
  };
  const choose = async (slot: 'primary' | 'secondary') => {
    setError(undefined);
    setBusy(true);
    try {
      const got = await pickColesStore();
      if (!got) return;
      await save(slot, got.storeNo, got.name);
      if (slot === 'primary') await runTest();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const saveTyped = async (key: 'branchStoreNo' | 'branchStoreNo2', value: string) => {
    const n = value.trim() ? colesStoreNo(value) : undefined;
    if (value.trim() && !n) {
      setError("That doesn't look like a Coles branch link or number. It's the number at the end of the branch page's address, like …/kirwan-0844.");
      return;
    }
    setError(undefined);
    await save(key === 'branchStoreNo' ? 'primary' : 'secondary', n);
  };
  const field = (key: 'branchStoreNo' | 'branchStoreNo2', label: string) => (
    <label className="field">
      <span>{label}</span>
      <input
        className="input"
        inputMode="url"
        placeholder="Branch number, or the branch page's link"
        value={texts[key]}
        onChange={(e) => setTexts((t) => ({ ...t, [key]: e.target.value }))}
        onBlur={(e) => void saveTyped(key, e.target.value)}
      />
    </label>
  );
  const where = (name: string | undefined, no: string) => `${name ? cleanStoreName(name) : 'your branch'} (branch ${no})`;
  return (
    <AccountCard
      inlineShop={inline}
      chain="coles"
      ok={on}
      status={
        on
          ? `Prices and stock at ${where(st.primary, st.branchStoreNo!)}${st.branchStoreNo2 ? `, and stock at ${where(st.secondary, st.branchStoreNo2)}` : ''}`
          : 'Online prices only, no stock'
      }
      info={{
        title: 'Your Coles branch',
        body: (
          <>
            <p className="small">
              Coles answers for any of its branches by branch number, without signing in. With your branch chosen, Restock shows that branch's own prices
              and stock instead of the website's. This is new, so it's marked Beta: if Coles doesn't answer for your branch, Restock uses the
              online prices and notes it in Settings → Advanced → Diagnostics.
            </p>
            <p className="small">
              <strong>Choose your Coles branch</strong> opens Coles' shop finder inside Restock. Tap your shop, and Restock picks up its number by
              itself and comes back. The number is the four digits at the end of the branch page's address, for example …/kirwan-0844.
            </p>
            <p className="small">
              <strong>Signing in to Coles</strong> isn't needed for prices. It's for sending your list into your Coles trolley, once Restock has
              learned how: sign in, then go to Settings → Advanced → Diagnostics → "Record adding to a trolley", add one item, and send the
              recording.
            </p>
          </>
        ),
      }}
    >
      {on ? (
        <div className="chips" style={{ flexWrap: 'wrap' }}>
          <button className="btn small" disabled={busy} onClick={() => void choose('primary')}>
            Change branch
          </button>
          <button className="btn small" disabled={test.busy} onClick={() => void runTest()}>
            {test.busy ? 'Asking Coles…' : 'Test it'}
          </button>
          <button className="btn small ghost" onClick={() => void updateSettings({ localPrices: false })}>
            Use online prices
          </button>
        </div>
      ) : (
        <button className="btn primary" disabled={busy || !isNative()} onClick={() => void choose('primary')}>
          {busy ? 'Opening Coles…' : isNative() ? 'Choose your Coles branch' : 'Choosing your branch works in the Android app'}
        </button>
      )}
      {!on && st.branchStoreNo && (
        <button className="linkish small" style={{ padding: 0, alignSelf: 'flex-start' }} onClick={() => void updateSettings({ localPrices: true })}>
          Use {where(st.primary, st.branchStoreNo)} again
        </button>
      )}
      {on && !st.branchStoreNo2 && (
        <button className="linkish small" style={{ padding: 0, alignSelf: 'flex-start' }} disabled={busy} onClick={() => void choose('secondary')}>
          + Add a 2nd Coles, for its stock
        </button>
      )}
      {on && st.branchStoreNo2 && (
        <div className="chips" style={{ flexWrap: 'wrap' }}>
          <button className="btn small" disabled={busy} onClick={() => void choose('secondary')}>
            Change 2nd branch
          </button>
          <button className="btn small ghost" onClick={() => void save('secondary', undefined)}>
            Remove 2nd branch
          </button>
        </div>
      )}
      {error && (
        <div className="banner amber" style={{ fontSize: 13 }}>
          {error}
        </div>
      )}
      {test.text && (
        <div className={`banner ${test.ok ? 'green' : 'amber'}`} style={{ fontSize: 13 }}>
          {test.text}
        </div>
      )}
      <details className="more">
        <summary className="small">Other ways</summary>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 8 }}>
          <p className="small" style={{ margin: 0 }}>
            Know the branch number? Type it here, or paste the branch page's link. Picking a branch on the map above fills it in too, when the map knows
            it.
          </p>
          {field('branchStoreNo', 'Your Coles branch number')}
          {field('branchStoreNo2', '2nd Coles (optional, for its stock)')}
          <div className="row" style={{ padding: 0, minHeight: 0, gap: 8 }}>
            <span className="grow small">
              <strong>Coles account</strong> · {signedIn ? 'signed in' : 'not signed in'} (only for your trolley, later)
            </span>
            {signedIn ? (
              <button className="btn small ghost" onClick={() => void stopUsingColes()}>
                Sign out
              </button>
            ) : (
              <button
                className="btn small"
                disabled={!isNative()}
                onClick={() =>
                  void signInColes(() =>
                    confirmAction('Did you sign in to Coles?', {
                      detail: "Coles doesn't tell Restock, so just say if you did.",
                      action: 'Yes, signed in',
                    }),
                  ).catch((e) => setError(errText(e)))
                }
              >
                Sign in
              </button>
            )}
          </div>
          <button className="linkish small" style={{ padding: 0, alignSelf: 'flex-start' }} onClick={() => nav.push({ name: 'diagnostics' })}>
            Teach Restock your Coles trolley (Diagnostics)
          </button>
        </div>
      </details>
    </AccountCard>
  );
}

/**
 * Check your stores: what Restock can see at each supermarket you use. Coles answers per store
 * (prices and stock, at your primary and second branch) when asked by store number; Woolworths only
 * does that for a signed-in shopper, and Aldi doesn't share stock, so those stay as their websites
 * show them.
 */
/** 0.9.9: what a shop tells Restock about stock at your branch, in one line. */
function stockLine(settings: Settings, chain: string): string {
  if (chain === 'woolworths')
    return settings.accounts?.woolworths?.signedIn ? 'Stock at your signed-in Woolworths, at each price check.' : 'Sign in to see stock at your Woolworths. Woolworths only says it for the store on your account, so there\'s no second Woolworths for stock.';
  if (chain === 'coles') return settings.localPrices && storeChoice(settings, 'coles').branchStoreNo ? 'Stock at your Coles, and at a second Coles if you add one.' : 'Pick your Coles branch (above) to see its stock.';
  if (chain === 'aldi') return 'Aldi doesn\'t say what\'s in stock.';
  if (chain === 'costco') return 'Costco doesn\'t say what\'s in stock at a warehouse.';
  return 'This shop doesn\'t tell Restock about stock at your branch.';
}

/** 0.9.9: the short line under a shop's name: signed in or not, or how its prices work. */
function shopStatus(settings: Settings, chain: string): string {
  if (chain === 'woolworths') {
    const a = settings.accounts?.woolworths;
    return a?.signedIn ? `Signed in · prices and stock at ${a.storeName ?? 'your store'}` : 'Not signed in · online prices, no stock';
  }
  if (chain === 'coles') {
    const no = settings.localPrices ? storeChoice(settings, 'coles').branchStoreNo : undefined;
    return no ? `Prices and stock at your Coles (branch ${no})` : 'Online prices, no stock';
  }
  if (chain === 'aldi') return 'One price for everyone. No sign-in.';
  if (chain === 'costco') return settings.accounts?.costco?.signedIn ? 'Signed in · member prices' : 'Not signed in · online prices';
  // 0.10.3: IGA's prices are the store picked on its website (sign in there too, if you like).
  if (shopDef(chain)?.pickOnSite) return `Prices at the ${chainName(chain)} store you pick on its website.`;
  return "Prices from the shop's website. No sign-in.";
}

/**
 * 0.9.9: every shop, on every tab, has the same thing under its name: one status line and an Edit
 * button. Edit opens the same sheet for every shop (never the website): Branches, Sign in, Stock, About.
 */
function ShopEdit({ settings, chain }: { settings: Settings; chain: StoreChain }) {
  const [open, setOpen] = useState(false);
  const blocked = useBlocked(chain);
  return (
    <div className="shop-extra">
      {blocked && (
        <span className="small shop-blocked">
          <Icon name="alert" size={15} /> Not working: tap Edit to unblock
        </span>
      )}
      <span className="small">{shopStatus(settings, chain)}</span>
      <button className="btn small" onClick={() => setOpen(true)} aria-label={`Edit ${chainName(chain)}`}>
        <Icon name="pencil" size={16} /> Edit {chainName(chain)}
      </button>
      {open && <ShopEditSheet settings={settings} chain={chain} onClose={() => setOpen(false)} />}
    </div>
  );
}

/** 0.9.10: the branch names typed by hand, behind a button: the map is the first way. */
function BranchByHand({ chain, choice, onSet }: { chain: StoreChain; choice: StoreChoice; onSet: (key: 'primary' | 'secondary', value: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  if (!open)
    return (
      <button className="btn small ghost" onClick={() => setOpen(true)}>
        <Icon name="pencil" size={16} /> Enter a branch yourself
      </button>
    );
  return (
    <div className="two">
      <input
        className="input"
        placeholder={`${chainName(chain)} branch name`}
        aria-label={`${chainName(chain)} main branch`}
        defaultValue={choice.primary ?? ''}
        onBlur={(e) => void onSet('primary', e.target.value.trim())}
      />
      <input
        className="input"
        placeholder="Second (optional)"
        aria-label={`${chainName(chain)} second branch`}
        defaultValue={choice.secondary ?? ''}
        onBlur={(e) => void onSet('secondary', e.target.value.trim())}
      />
    </div>
  );
}

/** 0.10.4: the shop's last search or price check was turned away (403 or a bot check). */
function useBlocked(chain: StoreChain): boolean {
  const health = useLive(getHealth, []);
  const h = health?.[chain];
  // 0.10.5: also a hidden-browser shop that keeps timing out or finding nothing.
  return !!h?.failingSince && offerUnblock(chain, h.error);
}

function ShopEditSheet({ settings, chain, onClose }: { settings: Settings; chain: StoreChain; onClose: () => void }) {
  const s = storeChoice(settings, chain);
  const blocked = useBlocked(chain);
  const setStore = async (key: 'primary' | 'secondary', value: string) => {
    const latest = await getSettings();
    await updateSettings({ stores: { ...latest.stores, [chain]: { ...storeChoice(latest, chain), [key]: value || undefined } } });
  };
  const signIn = chain === 'woolworths' || chain === 'coles' || chain === 'costco';
  return (
    <Sheet title={chainName(chain)} onClose={onClose}>
      {blocked && (
        <div className="banner amber" role="status">
          <strong>{chainName(chain)} isn’t working</strong>
          <span style={{ fontSize: 13 }}>Its website may be checking for bots. That’s its check, not Restock’s. Unblock it once and prices carry on.</span>
          <div className="unblock-actions">
            <UnblockButton chain={chain} />
          </div>
        </div>
      )}
      <div className="eyebrow">Branches</div>
      <p className="small" style={{ margin: 0 }}>
        {[s.primary && `Main: ${s.primary}`, s.secondary && `2nd: ${s.secondary}`].filter(Boolean).join(' · ') || `${NO_BRANCH_YET(chain)}.`}
      </p>
      {/* 0.9.10: find this shop's own branches nearby, then tap Primary or 2nd. Typing is the fallback. */}
      <NearbyFinder settings={settings} section={sectionOf(chain)} only={chain} />
      <BranchByHand chain={chain} choice={s} onSet={setStore} />

      <div className="eyebrow">Sign in and your store</div>
      {chain === 'woolworths' && <WoolworthsAccount settings={settings} inline />}
      {chain === 'coles' && <ColesStore settings={settings} inline />}
      {chain === 'costco' && <CostcoAccount settings={settings} />}
      {!signIn && (
        <div className="row" aria-disabled="true" style={{ opacity: 0.55, padding: 0 }}>
          <span className="grow small">{chain === 'aldi' ? 'Aldi has no account to sign in to.' : "Restock doesn't sign in to this shop. Its website's prices are the same for everyone."}</span>
        </div>
      )}

      <div className="eyebrow">Stock</div>
      <p className="small" style={{ margin: 0 }}>
        {stockLine(settings, chain)}
      </p>

      {chain === 'aldi' && <AldiAbout />}
      {!signIn && chain !== 'aldi' && (
        <details className="explain">
          <summary>
            <Icon name="info" size={18} />
            <span>About {chainName(chain)}</span>
          </summary>
          <div className="explain-body">
            <p className="small">
              <strong>Works:</strong> Restock searches {chainName(chain)}'s website when you search, and checks the prices of what you track.
            </p>
            <p className="small">
              <strong>Doesn't:</strong> no sign-in, no stock, and some shops set prices per branch, so your local one can differ from the website.
            </p>
          </div>
        </details>
      )}
      <button className="btn primary" onClick={onClose}>
        Done
      </button>
    </Sheet>
  );
}

/** 0.9.8: Aldi under its tick, like the other shops: what works and what doesn't. */
function AldiAbout() {
  return (
    <div className="shop-extra">
      <span className="small">One price for everyone. No sign-in.</span>
      <details className="explain">
        <summary>
          <Icon name="info" size={18} />
          <span>About Aldi</span>
        </summary>
        <div className="explain-body">
          <p className="small">
            <strong>Works:</strong> Aldi's prices are the same at every branch, so what Restock finds is what you'll pay. Special Buys show when Aldi lists them.
          </p>
          <p className="small">
            <strong>Doesn't:</strong> Aldi doesn't say what's in stock, so Restock doesn't show any. There's no Aldi account to sign in to and no trolley to send your list to.
          </p>
        </div>
      </details>
    </div>
  );
}

/**
 * 0.9.7: Costco, picked with the other supermarkets. Off by default; picking it shows the notice
 * first. Once picked: the notice stays a tap away, and you can sign in for member prices.
 */
/** Costco's notice, the first time it's picked (then it's ticked like any shop). */
function CostcoAsk({ section, onClose }: { section: Section; onClose: () => void }) {
  const pick = async () => {
    onClose();
    const s = await getSettings();
    await updateSettings({ costco: { ...s.costco, on: true, acceptedAt: nowIso() } });
    await setShopFor('costco', section, true);
  };
  return (
    <Sheet title={COSTCO_SETTING_TITLE} onClose={onClose}>
      <div className="banner grey" role="note" style={{ fontSize: 13, flexDirection: 'column', alignItems: 'flex-start', gap: 6 }}>
        <strong>{COSTCO_NOTICE_HEADING}</strong>
        <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {COSTCO_NOTICE.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>
      <button className="btn primary" onClick={() => void pick()}>
        {COSTCO_TURN_ON}
      </button>
      <button className="btn" onClick={onClose}>
        {COSTCO_CANCEL}
      </button>
    </Sheet>
  );
}

/** 0.9.9: Costco's sign-in and its notice, in Costco's Edit sheet. */
function CostcoAccount({ settings }: { settings: Settings }) {
  const signedIn = !!settings.accounts?.costco?.signedIn;
  const notice = (
    <div className="banner grey" role="note" style={{ fontSize: 13, flexDirection: 'column', alignItems: 'flex-start', gap: 6 }}>
      <strong>{COSTCO_NOTICE_HEADING}</strong>
      <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {COSTCO_NOTICE.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
  return (
        <div className="shop-extra">
          <span className="small">{signedIn ? 'Signed in · member prices' : 'Not signed in · online prices'}</span>
          <details className="explain">
            <summary>
              <Icon name="info" size={18} />
              <span>About Costco: signed in or not</span>
            </summary>
            <div className="explain-body">
              <p className="small">
                <strong>Signed in:</strong> your member prices, and member-only items show their price.
              </p>
              <p className="small">
                <strong>Not signed in:</strong> Costco's public online prices. Member-only items show without a price.
              </p>
              <p className="small">You sign in on Costco's own page, so your password goes to Costco, not Restock.</p>
              {notice}
            </div>
          </details>
          {(signedIn ? (
              <div className="chips" style={{ flexWrap: 'wrap' }}>
                <button className="btn small ghost" onClick={() => void stopUsingCostco()}>
                  Sign out
                </button>
              </div>
            ) : (
              <button
                className="btn primary"
                disabled={!isNative()}
                onClick={() =>
                  void signInCostco(() =>
                    confirmAction('Did you sign in to Costco?', { detail: "Costco doesn't tell Restock, so just say if you did.", action: 'Yes, signed in' }),
                  ).catch(() => undefined)
                }
              >
                {isNative() ? 'Sign in to Costco' : 'Sign in works in the Android app'}
              </button>
            ))}
        </div>
  );
}
