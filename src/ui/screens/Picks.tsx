// 0.13.0: "See what Declan and Sarah use" (lib/makerPicks.ts): their pantry, by category. Tick what you
// want, or Select all, then Add to my pantry. Anything you already have by that name is greyed and
// left alone; the message afterwards says how many were added and how many were skipped.
import { useMemo, useState } from 'react';
import { checkPrices } from '../../lib/check';
import { guessCategoryId } from '../../lib/categoryGuess';
import { allCategories, allGroups, allProducts, insertGroupOp, insertProductOp, nowIso, runOps, uid } from '../../lib/db';
import { tidyItemName } from '../../lib/itemName';
import type { SqlOp } from '../../lib/sql/driver';
import type { StoreProduct } from '../../stores';
import { allPicks, pickCategoryIds, PICKS_ABOUT, PICKS_TITLE, picksDone, picksYouHave, pickShops, type MakerPick } from '../../lib/makerPicks';
import { nameKey } from '../../lib/sameName';
import { act } from '../../lib/undo';
import { useLive } from '../../lib/useLive';
import { chainName } from '../../types';
import { ChainDot, Thumb, TopBar } from '../components';
import { useNav } from '../nav';

/** "47 added to your pantry. 3 skipped: already in your pantry". */
export const picksSaid = (added: number, skipped: number): string =>
  `${added} item${added === 1 ? '' : 's'} added to your pantry${skipped ? `. ${skipped} skipped: already in your pantry` : ''}`;

/**
 * Adds the ticked picks in one go (one write: a hundred items one at a time kept the screen waiting).
 * Never one whose name is already in use, by you or by an earlier pick in the same batch. A product
 * you already keep (the same shop's same product) is reused, not doubled.
 */
export async function addPicks(picks: MakerPick[]): Promise<{ added: number; skipped: number }> {
  const [groups, products, cats, catIds] = await Promise.all([allGroups(), allProducts(), allCategories().catch(() => []), pickCategoryIds()]);
  const names = new Set(groups.map((g) => nameKey(g.name)));
  const kept = new Map(products.map((x) => [`${x.chain}|${x.storeProductId ?? ''}`, x.id]));
  const ops: SqlOp[] = [];
  const idOf = (sp: StoreProduct): string => {
    const k = `${sp.chain}|${sp.storeProductId}`;
    let id = kept.get(k);
    if (!id) {
      id = uid();
      kept.set(k, id);
      ops.push(insertProductOp({ id, chain: sp.chain, name: sp.name, brand: sp.brand, size: sp.size, barcode: sp.barcode, storeProductId: sp.storeProductId, imageUrl: sp.imageUrl, createdAt: nowIso() }));
    }
    return id;
  };
  let added = 0;
  let skipped = 0;
  for (const p of picks) {
    const key = nameKey(p.name);
    if (!key || names.has(key)) {
      skipped++;
      continue;
    }
    names.add(key);
    const ids = [...new Set(p.main.map(idOf))];
    const altIds = [...new Set(p.alts.map(idOf))].filter((id) => !ids.includes(id));
    // Their category when you have one of that name; else the one its name fits (as any new item).
    const categoryId = catIds.get(p.category.trim().toLowerCase()) || guessCategoryId([p.name, ...p.main.map((x) => x.name)], cats, 'pantry') || undefined;
    ops.push(
      insertGroupOp({
        id: uid(),
        name: tidyItemName(p.name),
        categoryId,
        usualProductId: ids[0],
        sameProductIds: ids.slice(1),
        altProductIds: altIds,
        alertLevel: 'good',
        allowBulk: p.allowBulk,
        allowMulti: p.allowMulti,
        section: 'pantry',
        createdAt: nowIso(),
      }),
    );
    added++;
  }
  if (ops.length) await runOps(ops);
  return { added, skipped };
}

export function PicksScreen() {
  const nav = useNav();
  const picks = useMemo(() => allPicks(), []);
  const groups = useLive(allGroups, []);
  const [ticked, setTicked] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const have = picksYouHave(picks, groups);
  const free = picks.filter((p) => !have.has(p.n));
  const chosen = free.filter((p) => ticked.has(p.n));
  const cats = [...new Set(picks.map((p) => p.category))];
  const all = free.length > 0 && chosen.length === free.length;
  const tick = (n: number) =>
    setTicked((t) => {
      const s = new Set(t);
      if (s.has(n)) s.delete(n);
      else s.add(n);
      return s;
    });
  const add = async () => {
    if (!chosen.length || busy) return;
    setBusy(true);
    try {
      let out = { added: 0, skipped: 0 };
      await act(
        () => picksSaid(out.added, out.skipped),
        async () => {
          out = await addPicks(chosen);
          // Select all: the ones left out because they're already yours are counted as skipped
          if (all) out = { ...out, skipped: out.skipped + have.size };
        },
      );
      picksDone('used');
      // Their prices are checked now, in the background (a phone's own price check).
      void checkPrices().catch(() => undefined);
      nav.pop();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="screen picks-screen">
      <TopBar title="Declan and Sarah's picks" />
      <p style={{ margin: 0 }}>{PICKS_ABOUT}</p>
      <p className="small" style={{ margin: 0 }}>
        Tick what you want, or select all. They go in your pantry only, not on your shopping list, and anything you already have by the same
        name is left exactly as it is. Prices aren't included: Restock checks each one once it's added.
      </p>
      <div className="picks-bar">
        <strong className="num" role="status">
          {chosen.length ? `${chosen.length} ticked` : `${free.length} to pick from`}
          {have.size > 0 && <span className="small"> · {have.size} already yours</span>}
        </strong>
        <button className="chip" disabled={!free.length} onClick={() => setTicked(all ? new Set() : new Set(free.map((p) => p.n)))}>
          {all ? 'Select none' : 'Select all'}
        </button>
      </div>
      {cats.map((c) => (
        <section key={c} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div className="eyebrow">{c}</div>
          <div className="card flush">
            {picks
              .filter((p) => p.category === c)
              .map((p) => {
                const mine = have.has(p.n);
                const on = ticked.has(p.n) && !mine;
                return (
                  <label key={p.n} className={`row pick-row${mine ? ' mine' : ''}`}>
                    <input type="checkbox" checked={on} disabled={mine} onChange={() => tick(p.n)} aria-label={mine ? `${p.name}: already in your pantry` : p.name} />
                    <Thumb src={p.main[0]?.imageUrl} icon="pantry" />
                    <span className="grow">
                      <span className="title" style={{ fontSize: 15 }}>
                        {p.name}
                      </span>
                      {mine ? (
                        <span className="small">Already in your pantry</span>
                      ) : (
                        <span className="small pick-shops">
                          {pickShops(p).map((s) => (
                            <span key={s}>
                              <ChainDot chain={s} /> {chainName(s)}
                            </span>
                          ))}
                        </span>
                      )}
                    </span>
                  </label>
                );
              })}
          </div>
        </section>
      ))}
      <div className="sticky-cta picks-end">
        <button className="btn primary block" disabled={!chosen.length || busy} onClick={() => void add()}>
          {busy ? 'Adding…' : chosen.length ? `Add ${chosen.length} to my pantry` : 'Add to my pantry'}
        </button>
        <button className="btn block" onClick={nav.pop}>
          No thanks, I'll add my own
        </button>
      </div>
    </div>
  );
}

/** The offer at the bottom of the Pantry, until it's used or turned down. */
export function PicksOffer({ onNo }: { onNo: () => void }) {
  const nav = useNav();
  return (
    <div className="card picks-offer" role="region" aria-label={PICKS_TITLE}>
      <strong>Want a head start?</strong>
      <span className="small">Declan and Sarah make Restock. See what's in their pantry and add what you'd use: budget picks from Coles, Woolworths and Aldi.</span>
      <button className="btn primary block" onClick={() => nav.push({ name: 'picks' })}>
        {PICKS_TITLE}
      </button>
      <button
        className="btn block"
        onClick={() => {
          picksDone('no');
          onNo();
        }}
      >
        No thanks, I'll add my own
      </button>
    </div>
  );
}
