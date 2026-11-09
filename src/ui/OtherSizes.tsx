import { useId, useState } from 'react';
import { otherSizes, packLabel, vsLabel, type SizeOption } from '../lib/otherSizes';
import { formatUnitPrice, money } from '../lib/units';
import { chainName } from '../types';
import type { StoreProduct } from '../stores/types';
import { ChainDot, Icon, MoreInfo, Sheet } from './components';

/** Exactly what the ⓘ next to the switch says (0.9.1). */
export const OTHER_SIZES_HELP =
  "Same size, other packs compares the exact can or bottle you buy in bigger or smaller packs. Turn on other container sizes if you'd also buy a different can or bottle size, like 1.25L bottles instead of cans. Everything is compared on price per litre or per 100g.";

const keyOf = (sp: StoreProduct) => `${sp.chain}:${sp.storeProductId}`;

/**
 * "Other sizes of this" (0.9.1), on Add once you've ticked something and on an item's "Add another
 * pick": the same product in other packs of the same size, and (behind a switch, remembered in
 * settings) other container sizes, each with its price per litre or 100 g against yours.
 */
export function OtherSizesCard({
  anchor,
  pool,
  skip,
  picks,
  onToggle,
  onPreview,
  photoFor,
  containersOn,
  onContainers,
  searching,
}: {
  /** The product you picked (or the item's usual one). */
  anchor: StoreProduct;
  /** Every product the shops sent back. */
  pool: StoreProduct[];
  /** Leave these out (the item's own picks). */
  skip?: Set<string>;
  picks: Map<string, StoreProduct>;
  onToggle: (sp: StoreProduct) => void;
  onPreview: (sp: StoreProduct) => void;
  photoFor?: (sp: StoreProduct) => string | undefined;
  containersOn: boolean;
  onContainers: (on: boolean) => void;
  /** Still searching the shops for more of this brand. */
  searching?: boolean;
}) {
  const [help, setHelp] = useState(false);
  const id = useId();
  const found = otherSizes(anchor, pool, { skip });
  const mine = found.mine;
  if (!mine) return null;
  if (!found.packs.length && !found.containers.length && !searching) return null;
  const unit = mine.pack.unit;
  // The best value of everything showing, yours included.
  const shown = [...found.packs, ...(containersOn ? found.containers : [])];
  const pers = shown.map((x) => x.per).concat(mine.per !== undefined ? [mine.per] : []);
  const best = shown.length && pers.length ? Math.min(...pers) : undefined;

  const row = (o: SizeOption) => {
    const ticked = picks.has(keyOf(o.sp));
    const vs = vsLabel(o.vs, unit);
    return (
      <label key={keyOf(o.sp)} className={`row${ticked ? ' selected' : ''}`}>
        <input type="checkbox" checked={ticked} onChange={() => onToggle(o.sp)} aria-label={`Tick ${o.sp.name} at ${chainName(o.sp.chain)}`} />
        <MoreInfo src={o.sp.imageUrl ?? photoFor?.(o.sp)} name={o.sp.name} onOpen={() => onPreview(o.sp)} />
        <span className="grow">
          <span className="title" style={{ fontSize: 15 }}>
            {packLabel(o.pack)}
          </span>
          <span className="small size-line">
            <ChainDot chain={o.sp.chain} /> {chainName(o.sp.chain)}
          </span>
          <span className="small size-name">{o.sp.name}</span>
          {(vs || o.per === best) && (
            <span className="tags">
              {o.per === best && <span className="tag great">BEST VALUE</span>}
              {vs && <span className={`tag ${o.vs !== undefined && o.vs < -0.005 ? 'good' : 'normal'}`}>{vs}</span>}
            </span>
          )}
        </span>
        <span className="num size-price">
          <strong>{money(o.sp.price)}</strong>
          <span className="small">{formatUnitPrice(o.per, unit)}</span>
        </span>
      </label>
    );
  };

  return (
    <div className="card best-match other-sizes">
      <div className="eyebrow green">Other sizes of this</div>
      <span className="small">
        Yours: {packLabel(mine.pack)}
        {mine.per !== undefined ? `, ${formatUnitPrice(mine.per, unit)}` : ''}. Tick any you'd also buy as this item.
      </span>
      {searching && (
        <span className="small" role="status">
          Looking for other sizes…
        </span>
      )}

      <div className="sizes-group">
        <span className="small sizes-head">Same size, other packs</span>
        {found.packs.length > 0 ? (
          <div className="card flush" style={{ boxShadow: 'none' }}>
            {found.packs.map(row)}
          </div>
        ) : (
          !searching && <span className="small">No other packs of the {packLabel({ ...mine.pack, count: 1 })} found.</span>
        )}
      </div>

      <div className="check sizes-switch">
        <span style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <span className="title" style={{ fontSize: 15 }}>
            <label htmlFor={`${id}-on`}>Include other container sizes</label>
            <button type="button" className="icon-btn inline-info" aria-label="How other sizes are compared" onClick={() => setHelp(true)}>
              <Icon name="info" size={16} />
            </button>
          </span>
          <span className="small" id={`${id}-count`}>
            {found.containers.length ? `${found.containers.length} found` : searching ? 'Looking…' : 'None found'}
          </span>
        </span>
        <input
          id={`${id}-on`}
          type="checkbox"
          className="switch"
          checked={containersOn}
          onChange={(e) => onContainers(e.target.checked)}
          aria-describedby={`${id}-count`}
        />
      </div>

      {containersOn && found.containers.length > 0 && (
        <div className="sizes-group">
          <span className="small sizes-head">Other container sizes</span>
          <div className="card flush" style={{ boxShadow: 'none' }}>
            {found.containers.map(row)}
          </div>
        </div>
      )}

      {help && (
        <Sheet title="Other sizes of this" onClose={() => setHelp(false)}>
          <p>{OTHER_SIZES_HELP}</p>
        </Sheet>
      )}
    </div>
  );
}
