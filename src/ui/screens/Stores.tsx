import { useState } from 'react';
import { getSettings, nowIso, uid, updateSettings } from '../../lib/db';
import { request as askPermission } from '../../lib/permissions';
import { describePosition, findPickedShops, nearbyStores, searchArea, type Area, type NearbyStore } from '../../lib/places';
import { RestockNative } from '../../lib/sql/native';
import { useLive } from '../../lib/useLive';
import {
  chainName,
  enabledIn,
  GROCERY,
  hostOf,
  SECTION_NAMES,
  SECTION_SHOPS,
  sectionOn,
  shopDef,
  shopsIn,
  type CustomShop,
  type Section,
  type StoreChain,
} from '../../shops';
import { adapterFor } from '../../stores';
import { isNative } from '../../stores/http';
import { forgetSearchInfo } from '../../stores/web';
import { colesStoreNo, stockAtBranch, storeChoice, wooliesAccount, type Settings, type ShopAccount, type StoreChoice } from '../../types';
import { checkWoolworths, openWoolworths, signInColes, signInWoolworths, stopUsingColes, stopUsingWoolworths } from '../../lib/accounts';
import { confirmAction } from '../../lib/confirm';
import { ChainDot, Icon, LoadingBar, Sheet, TopBar } from '../components';
import { useNav } from '../nav';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The word Restock searches for when testing a shop. */
export const TEST_WORD: Record<Section, string> = { pantry: 'milk', keg: 'beer', pharmacy: 'paracetamol' };

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

function NearbyFinder({ settings, section }: { settings: Settings; section: Section }) {
  const [q, setQ] = useState('');
  const [areas, setAreas] = useState<Area[]>();
  const [stores, setStores] = useState<NearbyStore[]>();
  const [busy, setBusy] = useState<string>();
  /** How long the current search usually takes, for the loading bar. */
  const [wait, setWait] = useState<number>();
  const [error, setError] = useState<string>();
  const picked0 = enabledIn(settings.enabledChains, section);
  // With shops picked, start with just their branches; "Everything nearby" shows the rest.
  const [onlyMine, setOnlyMine] = useState(picked0.length > 0);
  const [deep, setDeep] = useState(false);
  const [expanded, setExpanded] = useState<Set<StoreChain>>(new Set());
  const what = SECTION_SHOPS[section];
  const picked: StoreChain[] = enabledIn(settings.enabledChains, section);

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
      await updateSettings({ area });
      if (harder) {
        const more = await findPickedShops(area.lat, area.lon, section, picked);
        setStores((cur) => {
          const have = new Set((cur ?? []).map((x) => x.id ?? `${x.chain}:${x.lat},${x.lon}`));
          return [...(cur ?? []), ...more.filter((x) => !have.has(x.id ?? `${x.chain}:${x.lat},${x.lon}`))];
        });
        setDeep(true);
        setOnlyMine(true);
      } else {
        setStores(await nearbyStores(area.lat, area.lon, section));
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
      return setError("Location isn't allowed. Search by suburb or postcode instead, or allow it in Settings → Permissions.");
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

  const list = (stores ?? []).filter((s) => !onlyMine || !picked.length || picked.includes(s.chain));
  const label = SECTION_NAMES[section] === 'Pantry' ? 'supermarkets' : what;

  return (
    <div className="card">
      <div className="title">Your nearest {label}</div>
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
          <button className="btn" type="submit" aria-label="Search" style={{ width: 52, padding: 0 }} disabled={!!busy}>
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
              <span className="grow title" style={{ fontSize: 14 }}>
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
          {picked.length > 0 && stores.length > 0 && (
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
                        <span className="title" style={{ fontSize: 14 }}>
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
                          aria-label={`Make ${s.name} your primary store`}
                        >
                          Primary
                        </button>
                        <button
                          className="chip"
                          aria-pressed={isBranch(cur, 'secondary', s, mine, stores)}
                          onClick={() => choose(s, 'secondary')}
                          aria-label={`Make ${s.name} your second store`}
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
            Store locations © OpenStreetMap contributors. Independent shops without a chain name aren't listed; add their website with "Other"
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

/** Turn a shop on or off (and the tab with it, the first time a shop is picked). */
async function setShop(chain: StoreChain, on: boolean) {
  const s = await getSettings();
  await updateSettings({ enabledChains: on ? [...new Set([...s.enabledChains, chain])] : s.enabledChains.filter((c) => c !== chain) });
}

/**
 * The bottle shops or pharmacies to use, as a dropdown of ticks: there are too many to show
 * them all at once. Shops you added yourself are listed too, with a way to add another.
 */
export function ShopDropdown({ settings, section, startOpen }: { settings: Settings; section: Section; startOpen?: boolean }) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<CustomShop>();
  const all = shopsIn(section);
  const picked = enabledIn(settings.enabledChains, section);
  // Open to start with in setup when nothing's picked; then it stays however the person leaves it.
  const [open, setOpen] = useState(!!startOpen && !picked.length);
  const summary = picked.length ? picked.map(chainName).join(', ') : `Pick your ${SECTION_SHOPS[section]}`;
  return (
    <>
      <details className="dropdown card flush" open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
        <summary className="row">
          <span className="grow">
            <span className="title" style={{ fontSize: 15 }}>
              {picked.length
                ? `${picked.length} ${picked.length === 1 ? SECTION_SHOPS[section].replace(/s$/, '').replace(/ie$/, 'y') : SECTION_SHOPS[section]} picked`
                : 'Choose shops'}
            </span>
            <span className="small clip">{summary}</span>
          </span>
          <Icon name="chevron" size={18} />
        </summary>
        {all.map((shop) => (
          <label key={shop.id} className="check">
            <input
              type="checkbox"
              checked={picked.includes(shop.id)}
              onChange={(e) => void setShop(shop.id, e.target.checked)}
              aria-label={`Use ${shop.name}`}
            />
            <ChainDot chain={shop.id} />
            <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
              <span>{shop.name}</span>
              {shop.note && <span className="small">{shop.note}</span>}
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
        ))}
        <button className="row" onClick={() => setAdding(true)}>
          <Icon name="plus" size={18} />
          <span className="grow">
            <span className="title" style={{ fontSize: 14 }}>
              Other: add a shop's website
            </span>
            <span className="small">Any shop with prices on its website. Give it a name and Restock reads its search page.</span>
          </span>
        </button>
      </details>
      {(adding || editing) && <CustomShopSheet section={section} shop={editing} onClose={() => (setAdding(false), setEditing(undefined))} />}
    </>
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
    try {
      const u = new URL(withScheme);
      return u.hostname.includes('.') ? `${u.protocol}//${u.host}` : '';
    } catch {
      return '';
    }
  })();
  const search = searchAt.trim() ? (searchAt.includes('{q}') ? searchAt.trim() : '') : '';
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
        samples: items.slice(0, 3).map((p) => `${p.name} · $${p.price?.toFixed(2)}`),
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
          {searchAt.trim() && !search && (
            <span className="small" style={{ color: 'var(--red-ink)' }}>
              Put {'{q}'} where the search word goes.
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
export function SectionSwitch({ settings, section }: { settings: Settings; section: 'keg' | 'pharmacy' }) {
  const [askAge, setAskAge] = useState(false);
  const on = settings.sections[section];
  const turn = async (v: boolean) => {
    if (v && section === 'keg' && !settings.adultConfirmed) return setAskAge(true);
    await updateSettings({ sections: { ...settings.sections, [section]: v } });
  };
  return (
    <>
      <div className="card flush">
        <label className="check">
          <Icon name={section} size={22} />
          <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <span className="title" style={{ fontSize: 15 }}>
              {section === 'keg' ? 'Bottle shops (Keg tab)' : 'Pharmacies (Pharmacy tab)'}
            </span>
            <span className="small">
              {section === 'keg'
                ? 'Track beer, wine and spirits prices at the bottle shops you pick. Kept separate from groceries.'
                : 'Track medicine, first aid and personal care prices at the pharmacies you pick. Kept separate from groceries.'}
            </span>
          </span>
          <input type="checkbox" checked={on} onChange={(e) => void turn(e.target.checked)} aria-label={`Use the ${SECTION_NAMES[section]} tab`} />
        </label>
        {on && (
          <label className="check" style={{ borderTop: '1px solid var(--line)' }}>
            <span style={{ width: 22 }} />
            <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
              <span className="title" style={{ fontSize: 14 }}>
                Show {SECTION_NAMES[section]} in the bottom bar
              </span>
              <span className="small">
                Turn this off if you only buy {section === 'keg' ? 'a drink' : 'from a pharmacy'} now and then. You can still search these shops on
                Add and put things on your shopping list without tracking them.
              </span>
            </span>
            <input
              type="checkbox"
              checked={!settings.hiddenTabs?.includes(section)}
              onChange={(e) =>
                void updateSettings({
                  hiddenTabs: e.target.checked
                    ? (settings.hiddenTabs ?? []).filter((x) => x !== section)
                    : [...new Set([...(settings.hiddenTabs ?? []), section])],
                })
              }
              aria-label={`Show ${SECTION_NAMES[section]} in the bottom bar`}
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
  const chains = enabledIn(settings.enabledChains, section);
  const setStore = async (chain: StoreChain, key: 'primary' | 'secondary' | 'storeId', value: string) => {
    const latest = await getSettings();
    await updateSettings({ stores: { ...latest.stores, [chain]: { ...storeChoice(latest, chain), [key]: value || undefined } } });
  };
  if (!chains.length) return null;
  return (
    <details className="explain">
      <summary>
        <Icon name="pencil" size={18} />
        <span>Type store names yourself</span>
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
                  placeholder="Primary store"
                  aria-label={`${chainName(chain)} primary store`}
                  defaultValue={s.primary ?? ''}
                  onBlur={(e) => void setStore(chain, 'primary', e.target.value.trim())}
                />
                <input
                  key={`s-${s.secondary ?? ''}`}
                  className="input"
                  placeholder="Second (optional)"
                  aria-label={`${chainName(chain)} second store`}
                  defaultValue={s.secondary ?? ''}
                  onBlur={(e) => void setStore(chain, 'secondary', e.target.value.trim())}
                />
              </div>
              {chain === 'coles' && (
                <input
                  className="input"
                  inputMode="numeric"
                  placeholder="Advanced: Coles store ID (4 digits)"
                  aria-label="Coles store ID"
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
export function StoreFields({ settings, section = 'pantry', inSetup }: { settings: Settings; section?: Section; inSetup?: boolean }) {
  const label = section === 'pantry' ? 'supermarkets' : SECTION_SHOPS[section];
  if (section === 'pantry') {
    return (
      <>
        <div className="eyebrow">1 · Your supermarkets</div>
        <div className="card flush">
          {GROCERY.map((chain) => {
            const on = settings.enabledChains.includes(chain);
            const st = storeChoice(settings, chain);
            return (
              <label key={chain} className="check">
                <input type="checkbox" checked={on} onChange={(e) => void setShop(chain, e.target.checked)} aria-label={`Use ${chainName(chain)}`} />
                <ChainDot chain={chain} />
                <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                  <span>{chainName(chain)}</span>
                  {on && <span className="small">{branchText(st)}</span>}
                </span>
              </label>
            );
          })}
          <ShopDropdownCustomOnly settings={settings} />
        </div>
        <div className="eyebrow">2 · Your branches</div>
        {/* Keyed by tab only: picking a shop or a branch must not throw away the list you're looking at. */}
        <NearbyFinder key="pantry" settings={settings} section="pantry" />
        <ManualNames settings={settings} section="pantry" />
        <div className="eyebrow">3 · Check your stores</div>
        <LocalPrices settings={settings} />
      </>
    );
  }
  const on = settings.sections[section];
  return (
    <>
      <SectionSwitch settings={settings} section={section} />
      {on && (
        <>
          <div className="eyebrow">1 · Your {label}</div>
          <SelectedSummary settings={settings} section={section} />
          <ShopDropdown settings={settings} section={section} startOpen={inSetup} />
          {!sectionOn(settings, section) && (
            <p className="small">
              Pick at least one {section === 'keg' ? 'bottle shop' : 'pharmacy'} (here, or a branch below) to show the {SECTION_NAMES[section]} tab.
            </p>
          )}
          <div className="eyebrow">2 · Your branches</div>
          <NearbyFinder key={section} settings={settings} section={section} />
          <ManualNames settings={settings} section={section} />
          <p className="small">
            Prices come from each shop's website, so they're the online price.
            {section === 'pharmacy'
              ? ' Some pharmacies only show prices in store, or set them per store; those may come up with nothing.'
              : ' Some bottle shops set prices per store, so your local one can differ.'}
          </p>
        </>
      )}
    </>
  );
}

/** Supermarkets: the person's own grocery shops (a farmers' market site, IGA, and so on). */
function ShopDropdownCustomOnly({ settings }: { settings: Settings }) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<CustomShop>();
  const mine = settings.customShops.filter((c) => c.section === 'pantry');
  return (
    <>
      {mine.map((shop) => (
        <label key={shop.id} className="check">
          <input
            type="checkbox"
            checked={settings.enabledChains.includes(shop.id)}
            onChange={(e) => void setShop(shop.id, e.target.checked)}
            aria-label={`Use ${shop.name}`}
          />
          <ChainDot chain={shop.id} />
          <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <span>{shop.name}</span>
            <span className="small">{hostOf(shop.website)}</span>
          </span>
          <button type="button" className="btn small ghost" onClick={(e) => (e.preventDefault(), setEditing(shop))}>
            Edit
          </button>
        </label>
      ))}
      <button className="row" onClick={() => setAdding(true)}>
        <Icon name="plus" size={18} />
        <span className="grow">
          <span className="title" style={{ fontSize: 14 }}>
            Other: add a shop's website
          </span>
          <span className="small">IGA, a local grocer, or any shop with prices online</span>
        </span>
      </button>
      {(adding || editing) && <CustomShopSheet section="pantry" shop={editing} onClose={() => (setAdding(false), setEditing(undefined))} />}
    </>
  );
}

/** "Your store: Kirwan · 2nd: Upper Ross", or that no branch is picked yet. */
function branchText(st: StoreChoice): string {
  const primary = cleanStoreName(st.primary);
  const second = cleanStoreName(st.secondary);
  if (!primary && !second) return 'No branch picked yet (pick one below)';
  return [primary && `Your store: ${primary}`, second && `2nd: ${second}`].filter(Boolean).join(' · ');
}

/** Bottle shops and pharmacies: the shops in use and your branch at each, at a glance. */
function SelectedSummary({ settings, section }: { settings: Settings; section: Section }) {
  const chains = enabledIn(settings.enabledChains, section);
  if (!chains.length) return null;
  return (
    <div className="card flush">
      {chains.map((c) => {
        const st = storeChoice(settings, c);
        return (
          <div key={c} className="row">
            <ChainDot chain={c} />
            <span className="grow">
              <span className="title" style={{ fontSize: 14 }}>
                {chainName(c)}
              </span>
              <span className="small">{branchText(st)}</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function StoresScreen({ section = 'pantry' }: { section?: Section }) {
  const settings = useLive(getSettings, []);
  const nav = useNav();
  const [tab, setTab] = useState<Section>(section);
  return (
    <div className="screen">
      <TopBar title="My shops" />
      <div className="seg" role="tablist" aria-label="Which shops">
        {(['pantry', 'keg', 'pharmacy'] as Section[]).map((sec) => (
          <button key={sec} role="tab" aria-selected={sec === tab} className={sec === tab ? 'on' : ''} onClick={() => setTab(sec)}>
            <Icon name={sec} size={17} /> {sec === 'pantry' ? 'Groceries' : SECTION_NAMES[sec]}
          </button>
        ))}
      </div>
      {settings && <StoreFields key={tab} settings={settings} section={tab} />}
      {settings && (
        <button
          className="btn primary block"
          onClick={() => {
            const label = tab === 'pantry' ? 'Supermarkets' : tab === 'keg' ? 'Bottle shops' : 'Pharmacies';
            const summary = shopSummary(settings, tab);
            nav.toast(summary === 'Off' ? `${label} are off.` : `${label} saved: ${summary}`);
            nav.pop();
          }}
        >
          <Icon name="check" size={18} /> Done
        </button>
      )}
    </div>
  );
}

/** One line for Settings: which shops each tab uses. */
export function shopSummary(settings: Settings, section: Section): string {
  if (section !== 'pantry' && !settings.sections[section]) return 'Off';
  const chains = enabledIn(settings.enabledChains, section);
  if (!chains.length) return section === 'pantry' ? 'None picked' : 'On, but no shops picked yet';
  return chains
    .map((c) => {
      const s = storeChoice(settings, c);
      return s.primary && shopDef(c) ? `${chainName(c)} (${cleanStoreName(s.primary)})` : chainName(c);
    })
    .join(', ');
}

/**
 * Woolworths: sign in (your store's prices and stock, and your list straight into your trolley) or
 * don't (online prices, no stock). You sign in on Woolworths' own page inside Restock, so your
 * password goes to Woolworths, never to Restock.
 */
function WoolworthsAccount({ settings }: { settings: Settings }) {
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
              : { ok: false, text: 'Signed in, but no store is picked yet. Tap "Pick my store", choose Pick up and your store, then tap Done.' }
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
    <div className="woolies-account">
      <div className="title" style={{ fontSize: 15 }}>
        Woolworths account
      </div>
      <div className="acct-choices">
        <div className={`acct-choice${on ? ' on' : ''}`}>
          <strong>Sign in</strong>
          <span className="small">
            Your store's prices and stock. Send your shopping list straight into your Woolworths trolley, ready in the app.
          </span>
        </div>
        <div className={`acct-choice${on ? '' : ' on'}`}>
          <strong>Don't sign in</strong>
          <span className="small">Woolworths' online prices. No stock shown, as online stock isn't reliable for your store.</span>
        </div>
      </div>
      {on ? (
        <>
          <p className="small" style={{ margin: 0 }}>
            <strong>Signed in</strong>
            {acct?.storeId ? ` · your store: ${acct.storeName ?? `store ${acct.storeId}`}` : ' · no store picked yet'}
          </p>
          <div className="chips">
            <button
              className="btn small"
              disabled={!!busy}
              onClick={() =>
                void go(
                  'store',
                  async () => (await openWoolworths('Choose Pick up and your store at the top of the page. Then tap Done.'), checkWoolworths()),
                )
              }
            >
              Pick my store
            </button>
            <button className="btn small" disabled={!!busy} onClick={() => void go('check', checkWoolworths)}>
              {busy === 'check' ? 'Checking…' : 'Check again'}
            </button>
            <button className="btn small ghost" disabled={!!busy} onClick={() => void go('stop', stopUsingWoolworths)}>
              Stop using my account
            </button>
          </div>
        </>
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
      <p className="small" style={{ margin: 0 }}>
        You sign in on Woolworths' own page, so your password goes to Woolworths, not Restock. Restock then asks the Woolworths website for prices as
        you, and adds to your trolley only when you tap Send. Woolworths may not allow apps to do this, and it may stop working if they change their
        website.
      </p>
    </div>
  );
}

/**
 * Coles: sign in to fill your Coles trolley from your list. Not needed for your store's prices and
 * stock (its store number, below, does that).
 */
function ColesAccount({ settings }: { settings: Settings }) {
  const nav = useNav();
  const on = !!settings.accounts?.coles?.signedIn;
  const [error, setError] = useState<string>();
  return (
    <div className="woolies-account">
      <div className="title" style={{ fontSize: 15 }}>
        Coles account
      </div>
      <div className="acct-choices">
        <div className={`acct-choice${on ? ' on' : ''}`}>
          <strong>Sign in</strong>
          <span className="small">Send your shopping list straight into your Coles trolley (as soon as Restock has learned how: see below).</span>
        </div>
        <div className={`acct-choice${on ? '' : ' on'}`}>
          <strong>Don't sign in</strong>
          <span className="small">Everything else still works. Your store's prices and stock come from its store number below.</span>
        </div>
      </div>
      {on ? (
        <div className="chips">
          <span className="small" style={{ alignSelf: 'center' }}>
            <strong>Signed in</strong>
          </span>
          <button className="btn small ghost" onClick={() => void stopUsingColes()}>
            Stop using my account
          </button>
        </div>
      ) : (
        <button
          className="btn primary"
          disabled={!isNative()}
          onClick={() =>
            void signInColes(() =>
              confirmAction('Did you sign in to Coles?', { detail: "Coles doesn't tell Restock, so just say if you did.", action: 'Yes, signed in' }),
            ).catch((e) => setError(errText(e)))
          }
        >
          {isNative() ? 'Sign in to Coles' : 'Sign in works in the Android app'}
        </button>
      )}
      {error && (
        <div className="banner amber" style={{ fontSize: 13 }}>
          {error}
        </div>
      )}
      <p className="small" style={{ margin: 0 }}>
        To teach Restock your Coles trolley: sign in, then go to Settings → Diagnostics → "Record adding to a trolley", add one item, and send the
        recording.{' '}
        <button className="linkish small" style={{ padding: 0 }} onClick={() => nav.push({ name: 'diagnostics' })}>
          Open Diagnostics
        </button>
      </p>
    </div>
  );
}

/**
 * Check your stores: what Restock can see at each supermarket you use. Coles answers per store
 * (prices and stock, at your primary and second branch) when asked by store number; Woolworths only
 * does that for a signed-in shopper, and Aldi doesn't share stock, so those stay as their websites
 * show them.
 */
function LocalPrices({ settings }: { settings: Settings }) {
  const st = storeChoice(settings, 'coles');
  const coles = settings.enabledChains.includes('coles');
  const [texts, setTexts] = useState<Record<'branchStoreNo' | 'branchStoreNo2', string>>({
    branchStoreNo: st.branchStoreNo ?? '',
    branchStoreNo2: st.branchStoreNo2 ?? '',
  });
  const [error, setError] = useState<string>();
  const [test, setTest] = useState<{ busy?: boolean; text?: string; ok?: boolean }>({});
  const saveNo = async (key: 'branchStoreNo' | 'branchStoreNo2', value: string) => {
    const n = value.trim() ? colesStoreNo(value) : undefined;
    if (value.trim() && !n) {
      setError("That doesn't look like a Coles store link or number. It's the number at the end of the store's page, like …/kirwan-0844.");
      return;
    }
    setError(undefined);
    setTexts((t) => ({ ...t, [key]: n ?? '' }));
    const latest = await getSettings();
    await updateSettings({ stores: { ...latest.stores, coles: { ...storeChoice(latest, 'coles'), [key]: n } } });
  };
  const runTest = async () => {
    const no = storeChoice(await getSettings(), 'coles').branchStoreNo;
    if (!no) return;
    setTest({ busy: true });
    try {
      const { colesAtStore } = await import('../../stores/coles');
      const found = await colesAtStore('milk', no);
      setTest(
        found.length
          ? { ok: true, text: `Coles answered for store ${no}: ${found.length} products for "milk", with your store's prices and stock.` }
          : { ok: false, text: `Coles answered for store ${no} but found nothing. Check the store number.` },
      );
    } catch (e) {
      setTest({
        ok: false,
        text: isNative()
          ? `Coles didn't answer for store ${no} (${errText(e)}). Restock will use its online prices until it does.`
          : 'Testing works in the Android app.',
      });
    }
  };
  const field = (key: 'branchStoreNo' | 'branchStoreNo2', label: string, branch?: string) => (
    <label className="field">
      <span>
        {label}
        {branch ? ` (${cleanStoreName(branch)})` : ''}
      </span>
      <input
        className="input"
        inputMode="url"
        placeholder="Paste the store's page link, or its number"
        value={texts[key]}
        onChange={(e) => setTexts((t) => ({ ...t, [key]: e.target.value }))}
        onBlur={(e) => void saveNo(key, e.target.value)}
      />
    </label>
  );
  const row = (chain: StoreChain, what: string, ok: boolean) =>
    settings.enabledChains.includes(chain) && (
      <div className="row" style={{ padding: '6px 0', minHeight: 0, gap: 10 }}>
        <ChainDot chain={chain} />
        <span className="grow small" style={{ color: 'var(--ink-2)' }}>
          <strong>{chainName(chain)}:</strong> {what}
        </span>
        <Icon name={ok ? 'check' : 'info'} size={16} />
      </div>
    );
  return (
    <div className="card">
      <p className="small" style={{ margin: 0 }}>
        What Restock can check at each shop you use:
      </p>
      {row(
        'coles',
        settings.localPrices && st.branchStoreNo
          ? `prices and stock at ${st.primary ? cleanStoreName(st.primary) : 'your store'}${st.branchStoreNo2 ? ` and ${st.secondary ? cleanStoreName(st.secondary) : 'your 2nd store'}` : ''}`
          : "online prices only, and no stock (it isn't reliable for your store). Turn on your own store below.",
        !!(settings.localPrices && st.branchStoreNo),
      )}
      {row(
        'woolworths',
        wooliesAccount(settings)
          ? `prices and stock at ${stockAtBranch(settings, 'woolworths')}, and your list straight into your trolley`
          : "online prices only, and no stock (it isn't reliable for your store). Sign in below for your store's.",
        wooliesAccount(settings),
      )}
      {row('aldi', "one price for everyone. Aldi doesn't say what's in stock, so Restock doesn't show any.", false)}
      {settings.enabledChains.includes('woolworths') && <WoolworthsAccount settings={settings} />}
      {coles && <ColesAccount settings={settings} />}
      {coles && (
        <>
          <label className="check" style={{ padding: 0 }}>
            <input
              type="checkbox"
              checked={!!settings.localPrices}
              onChange={(e) => void updateSettings({ localPrices: e.target.checked })}
              aria-label="Prices and stock at my Coles"
            />
            <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
              <span className="title" style={{ fontSize: 15 }}>
                Prices and stock at my Coles (testing)
              </span>
              <span className="small">
                Ask Coles for your own stores instead of its online store. If Coles doesn't answer for your store, Restock uses the online prices and
                notes it in Settings → Diagnostics.
              </span>
            </span>
          </label>
          {settings.localPrices && (
            <>
              {field('branchStoreNo', 'Your Coles store number', st.primary)}
              {field('branchStoreNo2', '2nd Coles (optional, for its stock)', st.secondary)}
              {error && (
                <div className="banner amber" style={{ fontSize: 13 }}>
                  {error}
                </div>
              )}
              <p className="small" style={{ margin: 0 }}>
                {st.branchStoreNo
                  ? 'Picking a branch above fills these in when the map knows its number.'
                  : "The map didn't have your branch's number. On coles.com.au, open Find a store, pick your store, copy the page's link and paste it here."}{' '}
                <a href="https://www.coles.com.au/find-stores" target="_blank" rel="noreferrer">
                  Open Coles' store finder
                </a>
              </p>
              {st.branchStoreNo && (
                <button className="btn small" style={{ alignSelf: 'flex-start' }} disabled={test.busy} onClick={() => void runTest()}>
                  <Icon name="refresh" size={16} /> {test.busy ? 'Asking Coles…' : 'Test it'}
                </button>
              )}
              {test.text && (
                <div className={`banner ${test.ok ? 'green' : 'amber'}`} style={{ fontSize: 13 }}>
                  {test.text}
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
