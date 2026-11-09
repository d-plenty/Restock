import { useEffect, useState } from 'react';
import { addListEntry, allGroups, nowIso, uid } from '../../lib/db';
import { likeYourPantry, loadSpecials, type SpecialsList } from '../../lib/specials';
import { money } from '../../lib/units';
import { useLive } from '../../lib/useLive';
import { chainName } from '../../shops';
import { isNative } from '../../stores/http';
import type { StoreProduct } from '../../stores/types';
import { ChainDot, Icon, LoadingBar, Thumb, TopBar } from '../components';
import { useNav } from '../nav';

// Home → Specials: this week's half price at Woolworths and Coles, and Aldi's Special Buys.
// By default only the ones that look like things you buy.

export function SpecialsScreen() {
  const nav = useNav();
  const groups = useLive(allGroups, []);
  const [lists, setLists] = useState<SpecialsList[]>();
  const [busy, setBusy] = useState(false);
  const [mine, setMine] = useState(true);
  const load = async (fresh = false) => {
    setBusy(true);
    try {
      setLists(await loadSpecials(fresh));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const pantryNames = (groups ?? []).filter((g) => (g.section ?? 'pantry') === 'pantry').map((g) => g.name);
  const filterMine = mine && pantryNames.length > 0;

  const addToList = async (p: StoreProduct) => {
    await addListEntry({ id: uid(), text: p.name, chain: p.chain, price: p.price, section: 'pantry', checked: false, createdAt: nowIso() });
    nav.toast(`${p.name} added to your shopping list`);
  };

  return (
    <div className="screen">
      <TopBar title="Specials" />
      <p className="sub">This week's half price at Woolworths and Coles. Specials change on Wednesdays.</p>
      <div className="chips" role="group" aria-label="Which specials">
        <button className="chip" aria-pressed={filterMine} disabled={!pantryNames.length} onClick={() => setMine(true)}>
          Like what I buy
        </button>
        <button className="chip" aria-pressed={!filterMine} onClick={() => setMine(false)}>
          Everything
        </button>
        <button className="chip" onClick={() => void load(true)} disabled={busy} aria-label="Refresh the specials">
          <Icon name="refresh" size={15} /> Refresh
        </button>
      </div>
      {!pantryNames.length && <p className="small">Add a few things to your pantry and Restock can pick out the specials you're likely to want.</p>}
      {busy && (
        <div style={{ display: 'grid', gap: 8 }}>
          <span className="small" role="status">
            Getting this week's specials…
          </span>
          <LoadingBar seconds={15} />
        </div>
      )}
      {!busy && !isNative() && !lists?.length && <p className="small">Specials load in the Android app.</p>}

      {lists?.map((l) => {
        const items = filterMine ? likeYourPantry(l.items, pantryNames) : l.items;
        return (
          <section key={l.chain} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className="eyebrow" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <ChainDot chain={l.chain} /> {chainName(l.chain)} · half price
              <span className="small" style={{ marginLeft: 'auto', textTransform: 'none', letterSpacing: 0 }}>
                {items.length} {filterMine ? `of ${l.items.length}` : ''}
              </span>
            </div>
            {l.error && !l.items.length && (
              <div className="banner amber">
                {chainName(l.chain)} didn't send its specials: {l.error}
              </div>
            )}
            {!l.error && !items.length && (
              <p className="small">{filterMine ? 'Nothing like what you buy this week.' : 'No half-price specials found.'}</p>
            )}
            {items.length > 0 && (
              <div className="card flush">
                {items.slice(0, 60).map((p) => (
                  <div key={p.storeProductId} className="row">
                    <Thumb src={p.imageUrl} />
                    <span className="grow" style={{ minWidth: 0 }}>
                      <span className="title" style={{ fontSize: 15 }}>
                        {p.name}
                      </span>
                      <span className="small">
                        <strong className="num">{money(p.price)}</strong>
                        {p.wasPrice ? ` · was ${money(p.wasPrice)}` : ''}
                      </span>
                    </span>
                    <span style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <button className="btn small primary" onClick={() => void addToList(p)} aria-label={`Add ${p.name} to your shopping list`}>
                        <Icon name="cartPlus" size={16} /> List
                      </button>
                      <button className="btn small" onClick={() => nav.push({ name: 'add', query: p.name })} aria-label={`Track ${p.name}`}>
                        Track
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>
        );
      })}

      <div className="eyebrow" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <ChainDot chain="aldi" /> Aldi Special Buys
      </div>
      <a className="btn block" href="https://www.aldi.com.au/special-buys" style={{ textDecoration: 'none' }}>
        <Icon name="external" size={17} /> Open Aldi Special Buys
      </a>
      <p className="small">"List" adds it for this trip only. "Track" adds it to your pantry so Restock watches its price.</p>
    </div>
  );
}
