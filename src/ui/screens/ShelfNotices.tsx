import { useEffect, useState } from 'react';
import { confirmAction } from '../../lib/confirm';
import { getGroup, getSettings, refresh, removeProductFromGroup, updateGroup } from '../../lib/db';
import { ackChange, changeWords, foundAgain, hideMiss, missWords, replacementLine, replacementTerm, type ShelfNotes } from '../../lib/shelfWatch';
import { money } from '../../lib/units';
import { sizeLabel } from '../../lib/unitPrice';
import { act } from '../../lib/undo';
import type { Recommendation } from '../../lib/verdict';
import { adapterFor, type StoreProduct } from '../../stores';
import { isNative } from '../../stores/http';
import { chainName, searchStoreId, type StoreChain } from '../../types';
import { Icon, LoadingBar, Sheet, Thumb } from '../components';
import { saveStoreProducts } from './addSave';

// 0.11.3: on an item's page, under Products I buy: a pick whose pack changed size, and a pick its shop no
// longer lists (lib/shelfWatch.ts). "Find a replacement" searches that one shop, only when it's
// pressed, and nothing is swapped until you say so.

type Gone = ShelfNotes['gone'][number];

export function ShelfNotices({ rec }: { rec: Recommendation }) {
  const [finding, setFinding] = useState<Gone>();
  // The sheet stays up when its notice goes (a search that finds the product after all clears it).
  const notes = rec.shelf ?? { changed: [], gone: [] };
  if (!rec.shelf && !finding) return null;
  const several = (name: string) => rec.options.filter((o) => o.product.name === name).length > 1;
  return (
    <>
      {notes.changed.map((c) => {
        const w = changeWords(c.chain, c.change);
        return (
          <div key={`c-${c.productId}`} className={`banner ${w.smaller ? 'amber' : 'grey'} shelf-note`} role="note">
            <strong>{w.title}</strong>
            <span className="shelf-what">{c.name}</span>
            <span>{w.text}</span>
            <button
              className="btn small"
              onClick={async () => {
                await ackChange(c.productId);
                refresh();
              }}
            >
              Got it
            </button>
          </div>
        );
      })}
      {notes.gone.map((g) => {
        const w = missWords(g.chain, g.miss);
        return (
          <div key={`g-${g.productId}`} className="banner grey shelf-note" role="note">
            <strong>{w.title}</strong>
            <span className="shelf-what">
              {g.name}
              {several(g.name) ? ` at ${chainName(g.chain as StoreChain)}` : ''}
            </span>
            <span>{w.text}</span>
            <div className="shelf-actions">
              <button className="btn small primary" onClick={() => setFinding(g)}>
                <Icon name="search" size={16} /> Find a replacement
              </button>
              <button
                className="btn small"
                onClick={async () => {
                  await hideMiss(g.productId);
                  refresh();
                }}
              >
                Keep watching
              </button>
              <button
                className="btn small"
                onClick={async () => {
                  const ok = await confirmAction(`Remove ${g.name}?`, {
                    detail: `It comes off ${rec.group.name}, with its price history. You can undo it straight after.`,
                    action: 'Remove',
                  });
                  if (!ok) return;
                  await act(`${g.name} removed`, async () => {
                    const group = await getGroup(rec.group.id);
                    if (group) await removeProductFromGroup(group, g.productId);
                  });
                }}
              >
                Remove it
              </button>
            </div>
          </div>
        );
      })}
      {finding && <ReplaceSheet rec={rec} gone={finding} onClose={() => setFinding(undefined)} />}
    </>
  );
}

type Stage = { at: 'searching' } | { at: 'error'; message: string } | { at: 'done'; results: StoreProduct[]; still?: StoreProduct };

/** One search of the shop for what replaced a product, with how each result compares. */
function ReplaceSheet({ rec, gone, onClose }: { rec: Recommendation; gone: Gone; onClose: () => void }) {
  const shop = chainName(gone.chain as StoreChain);
  const old = rec.options.find((o) => o.product.id === gone.productId);
  const [stage, setStage] = useState<Stage>({ at: 'searching' });
  const [busy, setBusy] = useState<string>();
  const term = replacementTerm(gone.name);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        // (Test builds with canned shops search off a phone, like the Add screen.)
        if (!isNative() && import.meta.env.VITE_FAKE_STORES !== '1') throw new Error('Searching a shop happens on a phone.');
        const adapter = adapterFor(gone.chain as StoreChain);
        if (!adapter) throw new Error(`${shop} can't be searched from here.`);
        const settings = await getSettings();
        const found = await adapter.search(term, searchStoreId(settings, gone.chain as StoreChain));
        const oldId = old?.product.storeProductId;
        const still = oldId ? found.find((r) => r.storeProductId === oldId) : undefined;
        if (still) {
          // It's there after all: today's price is kept and the count is wiped.
          await saveStoreProducts([still]).catch(() => undefined);
          await foundAgain(gone.productId).catch(() => undefined);
        }
        if (live) setStage({ at: 'done', results: found.filter((r) => r.storeProductId !== oldId && r.price !== undefined).slice(0, 8), still });
      } catch (e) {
        if (live) setStage({ at: 'error', message: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => {
      live = false;
    };
    // One search, when the sheet opens (the button was the press).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const swap = async (sp: StoreProduct) => {
    const line = old ? replacementLine({ ...old.product, price: old.stats.typical ?? old.price }, sp) : undefined;
    const ok = await confirmAction(`Swap to ${sp.name}?`, {
      detail: `It takes the place of ${gone.name} in ${rec.group.name}.${line ? ` ${line}.` : ''} Its price history starts today. You can undo it straight after.`,
      action: 'Swap',
    });
    if (!ok) return;
    setBusy(sp.storeProductId);
    try {
      await act(`${sp.name} swapped in`, async () => {
        const [newId] = await saveStoreProducts([sp]);
        const group = await getGroup(rec.group.id);
        if (!group || !newId) return;
        // The new one goes where the old one was (your usual, a pick, or "also happy with"), then the old one comes off.
        const put = (ids: string[]) => [...new Set(ids.map((x) => (x === gone.productId ? newId : x)))];
        const usual = group.usualProductId === gone.productId ? newId : group.usualProductId;
        const same = put(group.sameProductIds).filter((x) => x !== usual);
        const alts = put(group.altProductIds).filter((x) => x !== usual && !same.includes(x));
        await updateGroup(group.id, { usualProductId: usual, sameProductIds: same, altProductIds: alts });
        // The old one is in no list now: this takes its product and prices away (unless another item uses it).
        const next = await getGroup(rec.group.id);
        if (next) await removeProductFromGroup(next, gone.productId);
      });
      onClose();
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <Sheet title={`A replacement at ${shop}`} onClose={onClose}>
      <p className="small" style={{ margin: 0 }}>
        Searching {shop} for "{term}". Pick the one that took its place and Restock swaps it into {rec.group.name}. Nothing changes until you choose.
      </p>
      {stage.at === 'searching' && (
        <div role="status" aria-label={`Searching ${shop}`}>
          <LoadingBar seconds={8} />
        </div>
      )}
      {stage.at === 'error' && (
        <div className="banner amber" role="alert">
          <strong>{shop} couldn't be searched</strong>
          <span>{stage.message}</span>
        </div>
      )}
      {stage.at === 'done' && stage.still && (
        <div className="banner green" role="status">
          <strong>{shop} still lists it</strong>
          <span>
            {stage.still.name} is {money(stage.still.price)} today. Restock keeps watching it, and the notice is gone.
          </span>
        </div>
      )}
      {stage.at === 'done' && !stage.still && stage.results.length === 0 && (
        <div className="banner grey" role="status">
          <strong>Nothing like it at {shop} right now</strong>
          <span>You can keep watching, remove it from the item, or add another product with the + on the item's page.</span>
        </div>
      )}
      {stage.at === 'done' && !stage.still && stage.results.length > 0 && (
        <div className="card flush">
          {stage.results.map((sp) => {
            const line = old ? replacementLine({ ...old.product, price: old.stats.typical ?? old.price }, sp) : undefined;
            return (
              <div key={sp.storeProductId} className="row shelf-result">
                <Thumb src={sp.imageUrl} />
                <span className="grow">
                  <span className="title" style={{ fontSize: 15 }}>
                    {sp.name}
                  </span>
                  <span className="small">
                    {sizeLabel({ name: sp.name, size: sp.size })} · {money(sp.price)}
                  </span>
                  {line && <span className="small shelf-line">{line}</span>}
                </span>
                <button className="btn small" disabled={!!busy} onClick={() => void swap(sp)}>
                  {busy === sp.storeProductId ? 'Swapping…' : 'Use this'}
                </button>
              </div>
            );
          })}
        </div>
      )}
      <button className="btn" onClick={onClose}>
        {stage.at === 'done' && stage.still ? 'Done' : 'Close'}
      </button>
    </Sheet>
  );
}
